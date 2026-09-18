import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, Experiment, parseRecording } from '../lib/experiment.ts';
import { evaluateNetwork } from '../lib/jev.ts';
import { parameters, step } from '../lib/physics.ts';

globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const providerAnswer = await evaluateNetwork({ topology: 'single', task: 'swingup', state: [0, Math.PI, 0, 0], time: 0, force: 10, representation: 'numeric', architecture: 'single' }, 'jev-test', async () => ({ model: 'jev-test', answers: { action: { type: 'choice', choice: 'LEFT', confidence: .7, probabilities: { LEFT: .9, RIGHT: .1 } } } }));

test('default experiment belongs to Jev and starts hanging down', () => {
  const e = new Experiment(); assert.equal(e.config.controller, 'jev'); assert.equal(e.config.task, 'swingup'); assert.ok(e.state[1] > 3); e.dispose();
});
test('wait clock freezes while Jev pending, then applies exactly chosen force for 20 ms', async () => {
  const e = new Experiment(); let resolve;
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  const before = [...e.state], pending = e.singleStep(); await sleep(20);
  assert.equal(e.time, 0); assert.deepEqual(e.state, before);
  resolve(Response.json(providerAnswer)); await pending;
  assert.equal(e.time, .02); assert.equal(e.force, -10);
  assert.deepEqual(e.state, step(before, -10, parameters('single'))); e.dispose();
});
test('reset discards late API reply with no leaked force or decision', async () => {
  const e = new Experiment(); let resolve;
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  const pending = e.singleStep(); e.reset(); const resetState = [...e.state];
  resolve(Response.json(providerAnswer)); await pending;
  assert.equal(e.time, 0); assert.equal(e.wall, 0); assert.equal(e.force, 0); assert.equal(e.decisions.length, 0); assert.deepEqual(e.state, resetState); e.dispose();
});
test('realtime clock keeps previous force while a network response is pending', async () => {
  const e = new Experiment({ ...DEFAULT_CONFIG, clock: 'realtime' }); let resolve;
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  e.force = 10; const before = [...e.state]; e.start();
  e.tick(performance.now() + 40);
  assert.ok(e.time >= .04); assert.equal(e.force, 10); assert.notDeepEqual(e.state, before);
  resolve(Response.json(providerAnswer)); await sleep(0);
  assert.equal(e.force, -10); assert.ok(e.decisions[0].appliedAt >= .04); e.dispose();
});
test('provider error pauses and does not use another controller', async () => {
  const e = new Experiment(); globalThis.fetch = async () => Response.json({ error: 'quota' }, { status: 429 });
  await e.singleStep(); assert.equal(e.config.controller, 'jev'); assert.equal(e.time, 0); assert.equal(e.decisions.length, 0); assert.match(e.error, /quota/); e.dispose();
});
test('recording replay uses recorded states and never makes API requests', async () => {
  const source = new Experiment({ ...DEFAULT_CONFIG, controller: 'manual' }); source.manual = 1; await source.singleStep();
  const recording = parseRecording(JSON.stringify(source.export()));
  const replay = new Experiment(); replay.load(recording); globalThis.fetch = () => { throw new Error('Unexpected API'); };
  await replay.singleStep(); assert.deepEqual(replay.state, recording.frames.at(-1).state);
  const broken = structuredClone(recording); broken.frames[0].state = [null]; assert.throws(() => parseRecording(JSON.stringify(broken))); source.dispose(); replay.dispose();
});

test('start, stop, resume and restart have distinct clock and state behavior', async () => {
  const e = new Experiment({ ...DEFAULT_CONFIG, controller: 'local', task: 'balance', clock: 'realtime' });
  globalThis.fetch = () => { throw new Error('Unexpected API'); };
  const initial = [...e.state];
  e.tick(performance.now() + 40);
  assert.deepEqual(e.state, initial); assert.equal(e.time, 0); assert.equal(e.running, false);
  await e.start(); e.tick(e.lastFrame + 40);
  assert.equal(e.time, .04); assert.notDeepEqual(e.state, initial);
  e.stop(); const stopped = [...e.state], savedTime = e.time;
  e.tick(e.lastFrame + 40);
  assert.deepEqual(e.state, stopped); assert.equal(e.time, savedTime); assert.equal(e.running, false);
  await e.start(); e.tick(e.lastFrame + 20);
  assert.equal(e.time, .06);
  await e.restart(); assert.equal(e.running, true); assert.equal(e.time, 0);
  assert.deepEqual(e.state, initial); assert.equal(e.decisions.length, 0);
  e.tick(e.lastFrame + 20); assert.equal(e.time, .02); e.dispose();
});

test('stop cancels a pending Jev decision, restart rejects its late response', async () => {
  const e = new Experiment(); let resolve;
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  const pending = e.singleStep(); e.stop(); e.restart();
  resolve(Response.json(providerAnswer)); await pending;
  assert.equal(e.time, 0); assert.equal(e.decisions.length, 0); assert.equal(e.force, 0); e.dispose();
});

for (const topology of ['single', 'double']) test(`${topology}: online balance runs without API and round-trips external-force recording`, async () => {
  const e = new Experiment({ ...DEFAULT_CONFIG, topology, task: 'balance', controller: 'local', clock: 'realtime' });
  globalThis.fetch = () => { throw new Error('Unexpected API'); };
  await e.start();
  for (let i = 0; i < 750 && e.running; i++) { if (i === 100) e.pushCart(4); if (i === 105) e.releaseCart(); e.tick(e.lastFrame + 40); await Promise.resolve(); }
  assert.equal(e.time, 30); assert.ok(e.bestBalance > 20); assert.equal(e.running, false);
  assert.equal(e.decisions.length, 1500);
  assert.ok(e.decisions.every(d => d.model === 'local-online-mpc-v2' && d.local && d.calls === 0 && d.inputTokens === 0 && !d.layers));
  assert.ok(e.frames.some(f => f.disturbanceForce === 4));
  const recording = parseRecording(JSON.stringify(e.export()));
  const replay = new Experiment(); replay.load(recording); replay.seek(recording.frames.length - 1);
  await replay.restart(); assert.equal(replay.time, 0); assert.equal(replay.running, true); assert.ok(replay.replay);
  const invalid = structuredClone(recording); invalid.decisions[0].local.reference = [null];
  assert.throws(() => parseRecording(JSON.stringify(invalid)));
  e.dispose(); replay.dispose();
});

test('local wait mode applies computed force only via the physics integrator', async () => {
  const e = new Experiment({ ...DEFAULT_CONFIG, task: 'balance', controller: 'local' });
  globalThis.fetch = () => { throw new Error('Unexpected API'); };
  const before = [...e.state]; await e.singleStep();
  assert.deepEqual(e.state, step(before, e.decisions[0].force, parameters('single')));
  assert.equal(e.time, .02); assert.equal(e.decisions[0].local.phase, e.decisions[0].phase); e.dispose();
});
