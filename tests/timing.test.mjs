import test from 'node:test';
import assert from 'node:assert/strict';
import { Experiment, DEFAULT_CONFIG } from '../lib/experiment.ts';

globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => { throw new Error('Local clocks must not call Jev'); };

async function run(controller, clock, hz, seconds) {
  const e = new Experiment({ ...DEFAULT_CONFIG, controller, clock, task: controller === 'local' ? 'balance' : 'swingup', duration: 120 });
  let notifications = 0;
  e.subscribe(() => notifications++);
  await e.start(); const start = e.lastFrame;
  for (let i = 1; i <= seconds * hz; i++) e.tick(start + i * 1000 / hz);
  assert.ok(Math.abs(e.time - seconds) < .00001, `${controller}/${clock}/${hz}Hz: ${e.time}s in ${seconds}s`);
  assert.ok(Math.abs(e.wall - seconds) < .00001);
  assert.equal(e.decisions.length, seconds * 50);
  assert.ok(notifications <= seconds * 10 + 5, `too many UI updates: ${notifications}`);
  const recording = e.export(); e.dispose(); return recording;
}

for (const controller of ['local', 'manual', 'random']) {
  test(`${controller}: both clocks run at 1x with identical physics at 30/60/120/144Hz`, async () => {
    const seconds = controller === 'local' ? 10 : 1;
    const baseline = await run(controller, 'wait', 60, seconds);
    for (const clock of ['wait', 'realtime']) for (const hz of [30, 60, 120, 144]) {
      const actual = await run(controller, clock, hz, seconds);
      assert.deepEqual(actual.frames.map(f => f.state), baseline.frames.map(f => f.state));
      assert.deepEqual(actual.decisions.map(d => d.force), baseline.decisions.map(d => d.force));
    }
  });
}

test('irregular display frames preserve all elapsed time and physics steps', async () => {
  const baseline = await run('local', 'wait', 60, 10);
  const e = new Experiment({ ...DEFAULT_CONFIG, controller: 'local', task: 'balance', duration: 120 });
  await e.start(); const start = e.lastFrame; let elapsed = 0, i = 0;
  while (elapsed < 10000) { elapsed = Math.min(10000, elapsed + [11, 57, 7, 90, 16][i++ % 5]); e.tick(start + elapsed); }
  assert.equal(e.time, 10);
  assert.deepEqual(e.state, baseline.frames.at(-1).state); e.dispose();
});

test('display interpolation stays between recorded frames and never changes physics', async () => {
  const e = new Experiment({ ...DEFAULT_CONFIG, controller: 'local', task: 'balance' });
  await e.start(); e.tick(e.lastFrame + 30);
  const actual = [...e.state], a = e.frames[0].state, b = e.frames[1].state;
  const displayed = e.displayState();
  displayed.forEach((v, i) => assert.ok(Math.abs(v - (a[i] + b[i]) / 2) < 1e-9));
  assert.deepEqual(e.state, actual);
  e.stop(); assert.deepEqual(e.displayState(), actual); e.dispose();
});

test('explicit local response delay is still honored in wait mode', async () => {
  const e = new Experiment({ ...DEFAULT_CONFIG, controller: 'local', task: 'balance', delay: 30 });
  const start = [...e.state], promise = e.singleStep();
  await Promise.resolve(); await Promise.resolve(); assert.equal(e.pending, true); assert.equal(e.time, 0); assert.deepEqual(e.state, start);
  await promise; assert.equal(e.time, .02); assert.ok(e.decisions[0].latency >= 25); e.dispose();
});
