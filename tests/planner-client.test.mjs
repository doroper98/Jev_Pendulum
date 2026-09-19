import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPlanner } from '../lib/planner-client.ts';

class FakeWorker {
  onmessage = null; onerror = null; requests = []; terminated = false;
  postMessage(request) { this.requests.push(request); }
  terminate() { this.terminated = true; }
}
const request = { topology: 'single', state: [0, Math.PI, 0, 0], limit: 10 };
const result = { plan: { states: [request.state], forces: [], gains: [], cost: 1, iterations: 1 }, milliseconds: 20 };

test('browser transport awaits worker loading then sends the observed state', async () => {
  const worker = new FakeWorker(), client = new BrowserPlanner(async () => worker);
  const pending = client.solve(request); await Promise.resolve();
  assert.deepEqual(worker.requests, [request]); worker.onmessage({ data: { result } });
  assert.deepEqual(await pending, result);
  const next = client.solve(request); assert.equal(worker.requests.length, 2); worker.onmessage({ data: { result } }); await next;
  client.cancel(); assert.equal(worker.terminated, true);
});

test('stop during worker-module loading terminates late worker without starting a job', async () => {
  let loaded; const worker = new FakeWorker();
  const client = new BrowserPlanner(() => new Promise(resolve => { loaded = resolve; }));
  const pending = client.solve(request), rejected = assert.rejects(pending, /중단/);
  client.cancel(); loaded(worker); await rejected;
  assert.equal(worker.terminated, true); assert.equal(worker.requests.length, 0);
});

test('a failed worker is discarded so a new start can retry', async () => {
  const first = new FakeWorker(), second = new FakeWorker(); let attempts = 0;
  const client = new BrowserPlanner(async () => ++attempts === 1 ? first : second);
  const pending = client.solve(request), rejected = assert.rejects(pending, /스레드/); await Promise.resolve(); first.onerror(); await rejected;
  assert.equal(first.terminated, true);
  const retried = client.solve(request); await Promise.resolve(); second.onmessage({ data: { result } });
  assert.deepEqual(await retried, result); assert.equal(attempts, 2); client.cancel();
});
