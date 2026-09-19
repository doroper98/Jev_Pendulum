import test from 'node:test';
import assert from 'node:assert/strict';
import { Experiment, DEFAULT_CONFIG, parseRecording } from '../lib/experiment.ts';
import { parameters, step, massMatrix } from '../lib/physics.ts';

globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

test('cart push and drag add forces without moving position or replacing velocities', async () => {
  const e = new Experiment({ ...DEFAULT_CONFIG, controller: 'manual', clock: 'realtime' });
  const initial = [...e.state]; e.pushCart(4); e.dragCart(1); assert.deepEqual(e.state, initial); assert.equal(e.pushForce, 0);
  await e.start(); e.pushCart(4); assert.deepEqual(e.state, initial);
  e.tick(e.lastFrame + 20);
  assert.deepEqual(e.state, step(initial, 4, parameters('single')));
  assert.equal(e.frames.at(-1).controlForce, 0); assert.equal(e.frames.at(-1).disturbanceForce, 4);
  const before = [...e.state]; e.dragCart(1.2); assert.deepEqual(e.state, before);
  e.tick(e.lastFrame + 20); assert.equal(e.disturbanceForce, 20);
  assert.deepEqual(e.state, step(before, 20, parameters('single')));
  e.releaseCart(); e.tick(e.lastFrame + 20); assert.equal(e.disturbanceForce, 0);
  e.pushCart(-4); e.stop(); assert.equal(e.pushForce, 0); assert.equal(e.dragTarget, null);
  const recording = parseRecording(JSON.stringify(e.export())); assert.ok(recording.events.some(event => event.type.includes('drag')));
  const replay = new Experiment(); replay.load(recording); replay.seek(1); assert.equal(replay.disturbanceForce, 4);
  const original = [...replay.state]; await replay.start(); replay.pushCart(4); replay.dragCart(-1); assert.deepEqual(replay.state, original); assert.equal(replay.pushForce, 0);
  const invalid = structuredClone(recording); invalid.frames[1].disturbanceForce = 'bad'; assert.throws(() => parseRecording(JSON.stringify(invalid)));
  e.dispose(); replay.dispose();
});

test('external impulse changes generalized momentum by the applied impulse', () => {
  const e = new Experiment({ ...DEFAULT_CONFIG, topology: 'double', controller: 'manual' });
  const before = [...e.state], matrix = massMatrix(before, parameters('double')); e.disturb('pole');
  assert.deepEqual(e.state.slice(0, 3), before.slice(0, 3));
  const delta = e.state.slice(3).map((v, i) => v - before[3 + i]);
  matrix.forEach((row, i) => assert.ok(Math.abs(row.reduce((sum, m, j) => sum + m * delta[j], 0) - (i === 1 ? .12 : 0)) < 1e-9)); e.dispose();
});
