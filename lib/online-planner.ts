import { clamp, wrap, type State, type Topology } from './physics.ts';

export const PLAN_DT = .04;
export interface Plan { states: State[]; forces: number[]; gains: number[][]; cost: number; iterations: number; }

// Same coupled mass-matrix equations as physics.ts; explicit small SPD solve
// avoids allocations while evaluating thousands of hypothetical controls.
export function flow(s: State, u: number, topology: Topology): State {
  if (topology === 'single') {
    const c = Math.cos(s[1]), sn = Math.sin(s[1]);
    const a = 1.2, b = .3 * c, d = .45;
    const r0 = u - .06 * s[2] + .3 * sn * s[3] ** 2;
    const r1 = .3 * 9.81 * sn - .002 * s[3], det = a * d - b * b;
    return [s[2], s[3], (d * r0 - b * r1) / det, (a * r1 - b * r0) / det];
  }
  const c1 = Math.cos(s[1]), c2 = Math.cos(s[2]), delta = s[1] - s[2];
  const a = 1.27, b = .27 * .85 * c1, c = .12 * .75 * c2;
  const d = .27 * .85 ** 2, e = .12 * .85 * .75 * Math.cos(delta), f = .12 * .75 ** 2;
  const r0 = u - .06 * s[3] + .27 * .85 * Math.sin(s[1]) * s[4] ** 2 + .12 * .75 * Math.sin(s[2]) * s[5] ** 2;
  const torque = .002 * (s[5] - s[4]);
  const r1 = .27 * .85 * 9.81 * Math.sin(s[1]) - .12 * .85 * .75 * Math.sin(delta) * s[5] ** 2 - .002 * s[4] + torque;
  const r2 = .12 * .75 * 9.81 * Math.sin(s[2]) + .12 * .85 * .75 * Math.sin(delta) * s[4] ** 2 - torque;
  const dd = d - b * b / a, ee = e - b * c / a, ff = f - c * c / a;
  const rr1 = r1 - b * r0 / a, rr2 = r2 - c * r0 / a;
  const w2 = (rr2 - ee * rr1 / dd) / (ff - ee * ee / dd), w1 = (rr1 - ee * w2) / dd;
  return [s[3], s[4], s[5], (r0 - b * w1 - c * w2) / a, w1, w2];
}
export function predict(s: State, u: number, top: Topology, dt = PLAN_DT): State {
  const add = (a: State, b: State, t: number) => a.map((v, i) => v + b[i] * t);
  const a = flow(s, u, top), b = flow(add(s, a, dt / 2), u, top), c = flow(add(s, b, dt / 2), u, top), d = flow(add(s, c, dt), u, top);
  return s.map((v, i) => v + dt / 6 * (a[i] + 2 * b[i] + 2 * c[i] + d[i]));
}
const zeros = (n: number) => Array(n).fill(0) as number[];
const error = (s: State) => s.map((v, i) => i > 0 && i < s.length / 2 ? wrap(v) : v);
function weights(n: number, terminal: boolean) { return n === 4 ? (terminal ? [50, 250, 40, 30] : [2, 6, .5, .2]) : (terminal ? [50, 250, 250, 40, 30, 30] : [2, 6, 6, .5, .2, .2]); }
function stateCost(s: State, terminal = false) {
  const n = s.length, q = weights(n, terminal), x = error(s), gradient = zeros(n), hessian = zeros(n * n);
  let cost = 0;
  for (let i = 0; i < n; i++) { cost += .5 * q[i] * x[i] ** 2; gradient[i] = q[i] * x[i]; hessian[i * n + i] = q[i]; }
  const outside = Math.max(0, Math.abs(s[0]) - 1.8);
  cost += 5000 * outside ** 2; gradient[0] += 10000 * outside * Math.sign(s[0]); if (outside > 0) hessian[0] += 10000;
  return { cost, gradient, hessian };
}
const R = .04;
function rollout(start: State, forces: number[], top: Topology) {
  const states = [[...start]]; let cost = 0;
  for (const u of forces) { const s = states.at(-1)!; cost += stateCost(s).cost + .5 * R * u * u; const next = predict(s, u, top); if (next.some(v => !Number.isFinite(v) || Math.abs(v) > 1000)) return { states, cost: Infinity }; states.push(next); }
  cost += stateCost(states.at(-1)!, true).cost; return { states, cost };
}
function linearize(s: State, u: number, top: Topology, dt = PLAN_DT) {
  const n = s.length, a = zeros(n * n), b = zeros(n), h = 1e-4;
  for (let j = 0; j <= n; j++) {
    const plus = [...s], minus = [...s]; if (j < n) { plus[j] += h; minus[j] -= h; }
    const p = predict(plus, u + (j === n ? h : 0), top, dt), m = predict(minus, u - (j === n ? h : 0), top, dt);
    for (let i = 0; i < n; i++) { const value = (p[i] - m[i]) / (2 * h); if (j < n) a[i * n + j] = value; else b[i] = value; }
  }
  return { a, b };
}

const lqrCache = new Map<Topology, number[]>();
/** Solve upright feedback from the physical model at runtime, not a stored policy. */
export function uprightGain(top: Topology): number[] {
  const cached = lqrCache.get(top); if (cached) return cached;
  const n = top === 'single' ? 4 : 6, { a, b } = linearize(zeros(n), 0, top, .02);
  const q = n === 4 ? [10, 60, 4, 3] : [10, 60, 60, 4, 3, 3];
  let p = zeros(n * n); q.forEach((v, i) => { p[i * n + i] = v; }); let gain = zeros(n);
  for (let iteration = 0; iteration < 1500; iteration++) {
    const pa = zeros(n * n), pb = zeros(n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { pb[i] += p[i * n + j] * b[j]; for (let k = 0; k < n; k++) pa[i * n + k] += p[i * n + j] * a[j * n + k]; }
    const denominator = .15 + b.reduce((sum, v, i) => sum + v * pb[i], 0);
    gain = zeros(n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) gain[i] -= b[j] * pa[j * n + i] / denominator;
    const next = zeros(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { next[i * n + j] = i === j ? q[i] : 0; for (let k = 0; k < n; k++) next[i * n + j] += a[k * n + i] * (pa[k * n + j] + pb[k] * gain[j]); }
    const change = Math.max(...next.map((v, i) => Math.abs(v - p[i]))); p = next; if (change < 1e-8) break;
  }
  lqrCache.set(top, gain); return gain;
}
export function balanceCommand(s: State, top: Topology) { const delta = error(s); return uprightGain(top).reduce((sum, g, i) => sum + g * delta[i], 0); }
export function balanceForce(s: State, top: Topology, limit: number) { return clamp(balanceCommand(s, top), -limit, limit); }
export function canCapture(s: State, top: Topology, limit: number): boolean {
  const n = s.length / 2;
  if (s.slice(1, n).some(a => Math.abs(wrap(a)) > .6) || s.slice(n + 1).some(v => Math.abs(v) > 4)) return false;
  let predicted = [...s];
  for (let i = 0; i < 125; i++) { predicted = predict(predicted, balanceForce(predicted, top, limit), top, .02); if (Math.abs(predicted[0]) > 2.15 || predicted.some(v => !Number.isFinite(v))) return false; }
  return predicted.slice(1, n).every(a => Math.abs(wrap(a)) < .1) && predicted.slice(n + 1).every(v => Math.abs(v) < .3);
}
export function shiftPlan(plan: Plan, elapsed: number, top: Topology, limit: number, currentState?: State): number[] {
  if (currentState) {
    const result: number[] = []; let predicted = [...currentState];
    for (let t = 0; t < plan.forces.length; t++) {
      const age = elapsed + t * PLAN_DT, i = Math.floor((age + 1e-8) / PLAN_DT);
      let u = balanceForce(predicted, top, limit);
      if (i < plan.forces.length) {
        const reference = predict(plan.states[i], plan.forces[i], top, Math.max(0, age - i * PLAN_DT));
        u = clamp(plan.forces[i] + plan.gains[i].reduce((sum, g, j) => sum + g * (j > 0 && j < predicted.length / 2 ? wrap(predicted[j] - reference[j]) : predicted[j] - reference[j]), 0), -limit, limit);
      }
      result.push(u); predicted = predict(predicted, u, top);
    }
    return result;
  }
  const count = Math.min(plan.forces.length, Math.max(0, Math.round(elapsed / PLAN_DT)));
  const shifted = plan.forces.slice(count); let end = [...plan.states.at(-1)!];
  for (let i = 0; i < count; i++) { const u = balanceForce(end, top, limit); shifted.push(u); end = predict(end, u, top); }
  return shifted;
}

/** Online, box-constrained iterative LQR. No stored solutions or clock-indexed actions. */
export function optimize(start: State, top: Topology, limit: number, seedForces?: number[], maxIterations = 60): Plan {
  const n = start.length, count = top === 'single' ? 125 : 175;
  let forces = Array.from({ length: count }, (_, i) => clamp(seedForces?.[i] ?? 0, -limit, limit));
  let current = rollout(start, forces, top), regularization = 1, iterations = 0;
  let gains = Array.from({ length: count }, () => zeros(n));
  for (; iterations < maxIterations; iterations++) {
    if (!Number.isFinite(current.cost)) break;
    const derivatives = current.states.slice(0, count).map((s, i) => linearize(s, forces[i], top));
    const end = stateCost(current.states[count], true); let vx = end.gradient, vxx = end.hessian;
    const ks = zeros(count), nextGains = Array.from({ length: count }, () => zeros(n));
    for (let t = count - 1; t >= 0; t--) {
      const { a, b } = derivatives[t], stage = stateCost(current.states[t]);
      const va = zeros(n * n), vb = zeros(n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { vb[i] += vxx[i * n + j] * b[j]; for (let k = 0; k < n; k++) va[i * n + k] += vxx[i * n + j] * a[j * n + k]; }
      const qu = R * forces[t] + b.reduce((sum, v, i) => sum + v * vx[i], 0);
      const quu = R + regularization + b.reduce((sum, v, i) => sum + v * vb[i], 0);
      const qx = [...stage.gradient], qxx = [...stage.hessian], qux = zeros(n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { qx[i] += a[j * n + i] * vx[j]; qux[i] += b[j] * va[j * n + i]; for (let k = 0; k < n; k++) qxx[i * n + k] += a[j * n + i] * va[j * n + k]; }
      const k = clamp(-qu / quu, -limit - forces[t], limit - forces[t]), constrained = Math.abs(k + qu / quu) > 1e-8;
      const gain = qux.map(v => constrained ? 0 : -v / quu); ks[t] = k; nextGains[t] = gain;
      vx = qx.map((v, i) => v + gain[i] * (quu * k + qu) + qux[i] * k);
      vxx = qxx.map((v, index) => { const i = Math.floor(index / n), j = index % n; return v + gain[i] * quu * gain[j] + gain[i] * qux[j] + qux[i] * gain[j]; });
    }
    let accepted = false, improvement = 0;
    for (const alpha of [1, .5, .25, .1, .03, .01]) {
      const candidate: number[] = [], states = [[...start]]; let cost = 0;
      for (let t = 0; t < count; t++) {
        const s = states[t], delta = s.map((v, i) => v - current.states[t][i]);
        const u = clamp(forces[t] + alpha * ks[t] + nextGains[t].reduce((sum, g, i) => sum + g * delta[i], 0), -limit, limit);
        candidate.push(u); cost += stateCost(s).cost + .5 * R * u * u; const next = predict(s, u, top);
        if (next.some(v => !Number.isFinite(v) || Math.abs(v) > 1000)) { cost = Infinity; break; } states.push(next);
      }
      if (states.length === count + 1) cost += stateCost(states[count], true).cost;
      if (cost < current.cost) { improvement = current.cost - cost; current = { states, cost }; forces = candidate; gains = nextGains; accepted = true; break; }
    }
    regularization = clamp(regularization * (accepted ? .5 : 10), 1e-5, 1e8);
    if ((accepted && improvement < .001) || regularization >= 1e8) break;
  }
  return { ...current, forces, gains, iterations };
}
