import test from 'node:test';
import assert from 'node:assert/strict';
import { derivative, energy, initialState, parameters, step, finishReason } from '../lib/physics.ts';

for (const topology of ['single', 'double']) {
  test(`${topology}: energy conserved without force/damping`, () => {
    const p = { ...parameters(topology), cartDamping: 0, jointDamping: 0 };
    let s = topology === 'single' ? [.1, .8, .2, -.6] : [.1, .8, -1.2, .2, -.6, .7];
    const initial = energy(s, p);
    for (let i = 0; i < 1000; i++) s = step(s, 0, p);
    assert.ok(Math.abs(energy(s, p) - initial) < 2e-5, `energy error ${energy(s, p) - initial}`);
  });
  test(`${topology}: gravity acts naturally; no automatic upright correction`, () => {
    const p = parameters(topology), n = p.lengths.length + 1;
    const down = [0, ...Array(n - 1).fill(Math.PI), ...Array(n).fill(0)];
    const after = step(down, 0, p, 1);
    assert.ok(after.every((v, i) => Math.abs(v - down[i]) < 1e-10));
    let perturbed = initialState(topology, 'balance');
    for (let i = 0; i < 50; i++) perturbed = step(perturbed, 0, p);
    assert.ok(perturbed.slice(1, n).some(a => Math.abs(a) > .2));
  });
  test(`${topology}: force response mirrors left and right`, () => {
    const p = parameters(topology), n = p.lengths.length + 1, upright = Array(2 * n).fill(0);
    const right = step(upright, 10, p), left = step(upright, -10, p);
    assert.ok(right[0] > 0);
    for (let i = 0; i < right.length; i++) assert.ok(Math.abs(right[i] + left[i]) < 1e-12);
  });
}
test('single: acceleration agrees with analytic point-mass cart-pole equation', () => {
  const p = { ...parameters('single'), cartDamping: 0, jointDamping: 0 };
  const s = [.2, .4, .3, -.7], force = 3, [m] = p.masses, [l] = p.lengths, [x, theta, v, w] = s;
  const xdd = (force + m * l * w * w * Math.sin(theta) - m * p.gravity * Math.sin(theta) * Math.cos(theta)) / (p.cartMass + m * Math.sin(theta) ** 2);
  const tdd = (p.gravity * Math.sin(theta) - xdd * Math.cos(theta)) / l;
  const result = derivative(s, force, p);
  assert.ok(Math.abs(result[2] - xdd) < 1e-10); assert.ok(Math.abs(result[3] - tdd) < 1e-10);
});
test('swing-up may rotate fully; rail limit terminates without clamping/teleporting', () => {
  const p = parameters('double'), s = [0, Math.PI, Math.PI, 0, 0, 0];
  assert.equal(finishReason(s, p, 'swingup', 1), null);
  assert.notEqual(finishReason(s, p, 'balance', 1), null);
  const crossed = [2.41, 0, 0, 0, 0, 0]; assert.ok(finishReason(crossed, p, 'swingup', 1));
  assert.equal(crossed[0], 2.41);
});
