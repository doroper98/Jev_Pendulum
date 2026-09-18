import test from 'node:test';
import assert from 'node:assert/strict';
import plans from '../lib/local-plans.json' with { type: 'json' };
import { localControl } from '../lib/local-controller.ts';
import { initialState, parameters, step, isBalanced, finishReason } from '../lib/physics.ts';

for (const topology of ['single', 'double']) {
  test(`${topology}: generated targets obey the same physical equations and start hanging`, () => {
    const plan = plans[topology], p = parameters(topology);
    const start = initialState(topology, 'swingup', 42);
    assert.ok(plan.states[0].every((v, i) => Math.abs(v - start[i]) < 1e-10));
    for (let k = 0; k < plan.forces.length; k++) {
      const next = step(plan.states[k], plan.forces[k], p);
      assert.ok(Math.max(...next.map((v, i) => Math.abs(v - plan.states[k + 1][i]))) < 1e-6);
    }
  });
  for (const task of ['swingup', 'balance']) {
    test(`${topology} ${task}: all 17 initial jitters succeed within the rail at 10 N`, () => {
      for (let seed = 0; seed < 17; seed++) {
        const p = parameters(topology);
        let state = initialState(topology, task, seed), consecutive = 0, best = 0;
        for (let k = 0; k < 1500; k++) {
          const before = [...state];
          const control = localControl(topology, task, state, k * .02, 10);
          assert.deepEqual(state, before, 'controller must not edit its observed state');
          assert.ok(Math.abs(control.force) <= 10);
          state = step(state, control.force, p);
          assert.ok(state.every(Number.isFinite));
          assert.ok(Math.abs(state[0]) < p.rail, `seed ${seed} left rail`);
          if (task === 'balance') assert.equal(finishReason(state, p, task, k * .02, 31), null);
          consecutive = isBalanced(state, p) ? consecutive + .02 : 0;
          best = Math.max(best, consecutive);
        }
        assert.ok(best > 20, `seed ${seed}: only balanced ${best}s`);
        assert.ok(Math.max(...state.map(Math.abs)) < .001);
      }
    });
  }
  test(`${topology}: feedback reacts to physical disturbances and respects force limit`, () => {
    const p = parameters(topology), n = p.lengths.length + 1;
    let state = Array(n * 2).fill(0); state[n] = .4; state[n + 1] = .6;
    const answer = localControl(topology, 'balance', state, 15, 2);
    assert.notEqual(answer.feedback, 0); assert.ok(Math.abs(answer.force) <= 2);
    for (let k = 0; k < 750; k++) {
      state = step(state, localControl(topology, 'balance', state, 15 + k * .02, 10).force, p);
      assert.ok(Math.abs(state[0]) < p.rail);
    }
    assert.ok(Math.max(...state.map(Math.abs)) < .001);
  });
}
