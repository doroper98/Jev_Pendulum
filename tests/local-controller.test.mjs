import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalController } from '../lib/local-controller.ts';
import { flow, balanceForce } from '../lib/online-planner.ts';
import { runPlanner } from '../lib/planner-job.ts';
import { derivative, initialState, parameters, step, isBalanced, wrap } from '../lib/physics.ts';

for (const topology of ['single', 'double']) {
  test(`${topology}: planning dynamics match actual coupled physics`, () => {
    const p = parameters(topology), n = p.lengths.length + 1;
    for (let k = 0; k < 25; k++) {
      const s = Array.from({ length: n * 2 }, (_, i) => Math.sin(k * 1.3 + i) * (i < n ? 3 : 6)), force = Math.cos(k) * 10;
      const actual = derivative(s, force, p), prediction = flow(s, force, topology);
      prediction.forEach((v, i) => assert.ok(Math.abs(v - actual[i]) < 1e-9));
    }
  });
  for (const disturbed of [false, true]) test(`${topology}: online swing-up ${disturbed ? 'replans after cart pushes' : 'starts without a stored plan'}`, async () => {
    const c = new LocalController(topology, 10), p = parameters(topology);
    let state = initialState(topology, 'swingup'), balance = 0, best = 0, latest;
    await c.initialize(state, 0);
    for (let k = 0; k < 1500; k++) {
      const t = k * .02, before = [...state]; latest = c.control(state, t);
      assert.deepEqual(state, before, 'controller must not replace physical state');
      assert.ok(Math.abs(latest.force) <= 10);
      const external = disturbed && ((t >= 1.5 && t < 1.75) || (t >= 20 && t < 20.3)) ? 4 : 0;
      state = step(state, latest.force + external, p);
      await Promise.resolve(); await Promise.resolve();
      assert.ok(state.every(Number.isFinite)); assert.ok(Math.abs(state[0]) < p.rail);
      balance = isBalanced(state, p) ? balance + .02 : 0; best = Math.max(best, balance);
    }
    assert.ok(best > 5, `balanced only ${best}s`); assert.equal(latest.mode, 'balance'); assert.ok(latest.replans > 1);
    assert.ok(state.slice(1, state.length / 2).every(a => Math.abs(wrap(a)) < .01)); c.dispose();
  });
  test(`${topology}: equilibrium feedback depends on current state, not elapsed time`, async () => {
    const s = Array(topology === 'single' ? 4 : 6).fill(0), a = new LocalController(topology, 10), b = new LocalController(topology, 10);
    await a.initialize(s, 0); await b.initialize(s, 73);
    assert.equal(a.control(s, 0).force, b.control(s, 73).force);
    const changed = [...s]; changed[s.length / 2] += .6;
    assert.notEqual(a.control(s, 0).force, a.control(changed, 0).force);
    assert.ok(Math.abs(balanceForce(changed, topology, 2)) <= 2); a.dispose(); b.dispose();
  });
}

test('new search starts from supplied off-nominal state at any simulation time', async () => {
  const c = new LocalController('single', 10), state = [.3, 2.4, -.2, .4];
  await c.initialize(state, 48.2); const first = c.control(state, 48.2);
  assert.equal(first.plannedAt, 48.2); assert.deepEqual(first.reference, state); assert.equal(first.replans, 1); c.dispose();
});

test('a fall after balance starts a fresh search from the fallen state', async () => {
  const requests = [], client = { solve: request => { requests.push(request); return new Promise(() => {}); }, cancel() {} };
  const c = new LocalController('single', 10, client); await c.initialize([0, 0, 0, 0], 0);
  const fallen = [.2, 1.1, .3, 2]; const output = c.control(fallen, 8);
  assert.equal(output.mode, 'search'); assert.equal(requests.length, 1); assert.deepEqual(requests[0].state, fallen); assert.equal(requests[0].previous, undefined); c.dispose();
});

test('double swing-up still responds to pushes when every replan arrives 80ms late', async () => {
  let time = 0, queued = null, calls = 0;
  const client = {
    solve(request) { const result = runPlanner(request); if (++calls === 1) return Promise.resolve(result); return new Promise(resolve => { queued = { result, resolve, due: time + .08 }; }); },
    cancel() { queued = null; },
  };
  const c = new LocalController('double', 10, client), p = parameters('double');
  let state = initialState('double', 'swingup'), balance = 0, best = 0;
  await c.initialize(state, 0);
  for (let k = 0; k < 1500; k++) {
    time = k * .02; const control = c.control(state, time);
    const external = (time >= 1.5 && time < 1.75) || (time >= 20 && time < 20.3) ? 4 : 0;
    state = step(state, control.force + external, p);
    if (queued && time + .02 >= queued.due - 1e-8) { queued.resolve(queued.result); queued = null; }
    await Promise.resolve(); await Promise.resolve();
    assert.ok(Math.abs(state[0]) < p.rail);
    balance = isBalanced(state, p) ? balance + .02 : 0; best = Math.max(best, balance);
  }
  assert.ok(best > 2); assert.ok(calls > 1); c.dispose();
});

test('stopping initial search discards a late plan', async () => {
  let resolve;
  const client = { solve: () => new Promise(r => { resolve = r; }), cancel() {} };
  const c = new LocalController('single', 10, client), state = initialState('single', 'swingup');
  const pending = c.initialize(state, 0); c.suspend();
  resolve({ plan: { states: [state, state], forces: [0], gains: [[0, 0, 0, 0]], cost: 1, iterations: 0 }, milliseconds: 20 });
  await pending; assert.equal(c.ready, false); assert.equal(c.replans, 0); assert.equal(c.searching, false); c.dispose();
});
