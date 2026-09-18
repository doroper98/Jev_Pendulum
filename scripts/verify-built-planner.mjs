// Exercise the emitted worker constructor, not just the solver asset. This catches
// client builds that accidentally resolve browser workers against file:// URLs.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { Experiment, DEFAULT_CONFIG } from '../lib/experiment.ts';
import { LocalController } from '../lib/local-controller.ts';
import { BrowserPlanner } from '../lib/planner-client.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = join(project, 'dist/client');
const chunks = join(clientRoot, '_next/static/chunks');
const factoryFile = readdirSync(chunks).find(name => name.startsWith('planner.worker-') && /new Worker/.test(readFileSync(join(chunks, name), 'utf8')));
assert.ok(factoryFile, 'Expected a bundled worker-constructor module');
const { default: PlannerWorker } = await import(pathToFileURL(join(chunks, factoryFile)).href);
const previousWorker = globalThis.Worker, previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
const terminations = [];
const bootstrap = `import {parentPort,workerData} from 'node:worker_threads';
const queue=[];let loaded=false;
globalThis.postMessage=data=>parentPort.postMessage(data);
parentPort.on('message',data=>loaded?globalThis.onmessage({data}):queue.push(data));
await import(workerData);loaded=true;for(const data of queue)globalThis.onmessage({data});`;

class BrowserWorkerAdapter {
  onmessage = null; onerror = null;
  constructor(url) {
    const actual = new URL(String(url), 'https://planner-test.invalid/');
    assert.equal(actual.protocol, 'https:', 'Worker URL must resolve on the website, never file://');
    assert.equal(actual.origin, 'https://planner-test.invalid');
    const asset = resolve(clientRoot, '.' + actual.pathname);
    assert.ok(!relative(clientRoot, asset).startsWith('..'));
    this.thread = new NodeWorker(new URL('data:text/javascript,' + encodeURIComponent(bootstrap)), { workerData: pathToFileURL(asset).href });
    this.thread.on('message', data => this.onmessage?.({ data }));
    this.thread.on('error', error => this.onerror?.(error));
  }
  postMessage(value) { this.thread.postMessage(value); }
  terminate() { terminations.push(this.thread.terminate()); }
}

try {
  globalThis.Worker = BrowserWorkerAdapter;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  for (const topology of ['single', 'double']) {
    const engine = new Experiment({ ...DEFAULT_CONFIG, topology, controller: 'local' });
    engine.local = new LocalController(topology, 10, new BrowserPlanner(async () => new PlannerWorker()));
    try {
      const initial = [...engine.state];
      await engine.start();
      assert.equal(engine.running, true, engine.error);
      assert.equal(engine.pending, false);
      engine.tick(engine.lastFrame + 40);
      assert.equal(engine.time, .04, engine.error);
      assert.notDeepEqual(engine.state, initial);
      assert.equal(engine.decisions.length, 2);
      console.log(`Built ${topology} planner: web asset URL, first plan, start and motion verified.`);
    } finally { engine.dispose(); }
  }
} finally {
  await Promise.all(terminations);
  globalThis.Worker = previousWorker;
  globalThis.requestAnimationFrame = previousRaf;
  globalThis.cancelAnimationFrame = previousCancel;
}
