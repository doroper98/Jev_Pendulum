import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage, estimatedUsd, formatUsd, reportedUsage, usageFromDecisions, validUsage } from '../lib/usage.ts';
import { POST } from '../app/api/jev/route.ts';
import { evaluateNetwork } from '../lib/jev.ts';
import { DEFAULT_CONFIG, Experiment, parseRecording } from '../lib/experiment.ts';

const originalFetch = globalThis.fetch, originalKey = process.env.TYPESAFE_API_KEY;
afterEach(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey; });
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const observation = { topology: 'single', task: 'swingup', state: [0, 3.1, 0, 0], time: 0, force: 10, representation: 'numeric', architecture: 'single' };
function provider(request) {
  return { model: 'jev-1.13.0', usage: { input_tokens: 1000, output_tokens: 20 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const keys = Object.keys(q.criteria);
    return [id, { type: 'choice', choice: keys[0], confidence: .8, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? .8 : .2 / (keys.length - 1)])) }];
  })) };
}
const answer = await evaluateNetwork(observation, 'jev-latest', async q => provider(q));
const receipt = { ...emptyUsage(), calls: 1, inputTokens: 1000, outputTokens: 20 };
const request = architecture => new Request('https://lab.invalid/api/jev', { method: 'POST', body: JSON.stringify({ ...observation, architecture }) });

test('published price, free output and small nonzero charges retain precision', () => {
  assert.equal(estimatedUsd({ ...receipt, inputTokens: 1_000_000, outputTokens: 5_000_000 }), .042);
  assert.equal(formatUsd(estimatedUsd(receipt)), '$0.000042');
  assert.equal(formatUsd(estimatedUsd({ ...receipt, inputTokens: 1 })), '< $0.000001');
  assert.equal(formatUsd(estimatedUsd(emptyUsage())), '$0.000000');
});
test('missing or invalid usage stays unknown rather than becoming a free call', () => {
  for (const value of [undefined, null, -1, 1.5, Infinity, '1000']) {
    const u = reportedUsage({ usage: { input_tokens: value, output_tokens: 20 } });
    assert.equal(u.unreportedCalls, 1); assert.equal(u.inputTokens, 0);
  }
  assert.equal(validUsage({ ...receipt, unreportedCalls: 2 }), false);
  assert.equal(validUsage({ ...receipt, inputTokens: -2 }), false);
  assert.equal(usageFromDecisions([{ calls: 3, inputTokens: null }]).unreportedCalls, 3);
});
for (const [architecture, calls] of [['single', 1], ['serial', 3], ['bundle', 2], ['recurrent', 3]]) {
  test(`route counts every ${architecture} layer once, including bundled questions`, async () => {
    process.env.TYPESAFE_API_KEY = 'test-only';
    globalThis.fetch = async (_, init) => Response.json(provider(JSON.parse(init.body)));
    const response = await POST(request(architecture)), data = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(data.usage, { ...receipt, calls, inputTokens: 1000 * calls, outputTokens: 20 * calls });
  });
}
test('failed later layer retains earlier reported usage and marks failed call unknown', async () => {
  process.env.TYPESAFE_API_KEY = 'test-only'; let calls = 0;
  globalThis.fetch = async (_, init) => ++calls === 2 ? new Response('', { status: 429 }) : Response.json(provider(JSON.parse(init.body)));
  const response = await POST(request('serial')), data = await response.json();
  assert.equal(response.status, 429);
  assert.deepEqual(data.usage, { ...receipt, calls: 2, unreportedCalls: 1 });
});
test('invalid decision still accounts for provider-reported tokens', async () => {
  process.env.TYPESAFE_API_KEY = 'test-only';
  globalThis.fetch = async () => Response.json({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 1000, output_tokens: 20 } });
  const response = await POST(request('single'));
  assert.equal(response.status, 502); assert.deepEqual((await response.json()).usage, receipt);
});
test('reset clears run usage, preserves page usage; replay never adds charges', async () => {
  globalThis.fetch = async () => Response.json({ ...answer, usage: receipt });
  const e = new Experiment(); await e.singleStep();
  assert.deepEqual(e.usage, receipt); assert.deepEqual(e.sessionUsage, receipt);
  const recording = parseRecording(JSON.stringify(e.export()));
  e.reset(); assert.deepEqual(e.usage, emptyUsage()); assert.deepEqual(e.sessionUsage, receipt);
  globalThis.fetch = () => { throw new Error('Replay must not call API'); };
  e.load(recording); await e.singleStep();
  assert.deepEqual(e.usage, receipt); assert.deepEqual(e.sessionUsage, receipt);
  const invalid = structuredClone(recording); invalid.usage.calls = -1;
  assert.throws(() => parseRecording(JSON.stringify(invalid)));
  delete recording.usage; e.load(recording); assert.deepEqual(e.usage, receipt); e.dispose();
});
test('late receipt is counted in page total without affecting a restarted run', async () => {
  let resolve; globalThis.fetch = () => new Promise(r => { resolve = r; });
  const e = new Experiment(), pending = e.singleStep();
  e.reset(); resolve(Response.json({ ...answer, usage: receipt })); await pending;
  assert.deepEqual(e.usage, emptyUsage()); assert.deepEqual(e.sessionUsage, receipt);
  assert.equal(e.decisions.length, 0); assert.equal(e.time, 0); e.dispose();
});
test('partial failure receipts survive with no applied decision', async () => {
  const partial = { ...receipt, calls: 2, unreportedCalls: 1 };
  globalThis.fetch = async () => Response.json({ error: 'quota', usage: partial }, { status: 429 });
  const e = new Experiment(); await e.singleStep();
  assert.deepEqual(e.usage, partial); assert.deepEqual(e.sessionUsage, partial);
  assert.equal(e.decisions.length, 0); assert.equal(e.time, 0); e.dispose();
});
test('unreturned request remains unresolved; local modes create no usage', async () => {
  globalThis.fetch = async () => { throw new DOMException('Aborted', 'AbortError'); };
  const e = new Experiment(); await e.singleStep();
  assert.equal(e.usage.unresolvedRequests, 1); assert.equal(e.sessionUsage.unresolvedRequests, 1);
  e.reset({ ...DEFAULT_CONFIG, controller: 'manual' }); await e.singleStep();
  assert.deepEqual(e.usage, emptyUsage()); assert.equal(e.sessionUsage.unresolvedRequests, 1); e.dispose();
});
