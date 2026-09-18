/** Massless rigid links, point masses at endpoints, absolute angles from UP.
 * q = [cart x, theta1, (theta2)], state = [q..., qdot...]. SI units.
 * Solve the coupled Euler-Lagrange equations; both links are passive. */
export type Topology = 'single' | 'double';
export type Task = 'balance' | 'swingup';
export type State = number[];
export interface Physics {
  lengths: number[]; masses: number[]; cartMass: number; gravity: number;
  cartDamping: number; jointDamping: number; rail: number;
}
export const DT = 0.02;
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const degrees = (a: number) => wrap(a) * 180 / Math.PI;
export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export function parameters(topology: Topology): Physics {
  return { lengths: topology === 'single' ? [1.5] : [.85, .75], masses: topology === 'single' ? [.2] : [.15, .12], cartMass: 1, gravity: 9.81, cartDamping: .06, jointDamping: .002, rail: 2.4 };
}
export function initialState(topology: Topology, task: Task, seed = 42): State {
  const n = topology === 'single' ? 2 : 3;
  const jitter = ((seed % 17) - 8) * .001;
  return task === 'balance'
    ? [0, .045 + jitter, ...(n === 3 ? [-.025 + jitter] : []), ...Array(n).fill(0)]
    : [0, Math.PI - .02 + jitter, ...(n === 3 ? [Math.PI + .03] : []), ...Array(n).fill(0)];
}
export function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length, a = matrix.map((r, i) => [...r, rhs[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    if (Math.abs(a[i][i]) < 1e-12) throw new Error('Singular mass matrix');
    const d = a[i][i];
    for (let k = i; k <= n; k++) a[i][k] /= d;
    for (let j = 0; j < n; j++) if (j !== i) {
      const f = a[j][i];
      for (let k = i; k <= n; k++) a[j][k] -= f * a[i][k];
    }
  }
  return a.map(r => r[n]);
}
export function massMatrix(s: State, p: Physics): number[][] {
  const n = p.lengths.length + 1, m = Array.from({ length: n }, () => Array(n).fill(0));
  const suffix = (i: number) => p.masses.slice(i).reduce((a, b) => a + b, 0);
  m[0][0] = p.cartMass + suffix(0);
  for (let i = 1; i < n; i++) {
    m[0][i] = m[i][0] = suffix(i - 1) * p.lengths[i - 1] * Math.cos(s[i]);
    for (let j = 1; j < n; j++) m[i][j] = suffix(Math.max(i, j) - 1) * p.lengths[i - 1] * p.lengths[j - 1] * Math.cos(s[i] - s[j]);
  }
  return m;
}
export function derivative(s: State, force: number, p: Physics): State {
  const n = p.lengths.length + 1, rhs = Array(n).fill(0);
  const suffix = (i: number) => p.masses.slice(i).reduce((a, b) => a + b, 0);
  rhs[0] = force - p.cartDamping * s[n];
  for (let i = 1; i < n; i++) {
    const si = suffix(i - 1), li = p.lengths[i - 1];
    rhs[0] += si * li * Math.sin(s[i]) * s[n + i] ** 2;
    rhs[i] = si * p.gravity * li * Math.sin(s[i]);
    for (let j = 1; j < n; j++) rhs[i] -= suffix(Math.max(i, j) - 1) * li * p.lengths[j - 1] * Math.sin(s[i] - s[j]) * s[n + j] ** 2;
  }
  // Viscous damping at the cart pivot and at the relative second joint.
  rhs[1] -= p.jointDamping * s[n + 1];
  if (n === 3) {
    const torque = p.jointDamping * (s[n + 2] - s[n + 1]);
    rhs[1] += torque; rhs[2] -= torque;
  }
  return [...s.slice(n), ...solve(massMatrix(s, p), rhs)];
}
export function step(s: State, force: number, p: Physics, duration = DT): State {
  const count = Math.max(1, Math.ceil(duration / .005)), h = duration / count;
  let y = [...s];
  const add = (a: State, b: State, scale: number) => a.map((v, i) => v + scale * b[i]);
  for (let i = 0; i < count; i++) {
    const k1 = derivative(y, force, p), k2 = derivative(add(y, k1, h / 2), force, p);
    const k3 = derivative(add(y, k2, h / 2), force, p), k4 = derivative(add(y, k3, h), force, p);
    y = y.map((v, j) => v + h * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]) / 6);
  }
  return y;
}
export function energy(s: State, p: Physics): number {
  const n = p.lengths.length + 1, m = massMatrix(s, p);
  let e = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) e += .5 * s[n + i] * m[i][j] * s[n + j];
  for (let i = 0; i < p.lengths.length; i++) e += p.masses.slice(i).reduce((a, b) => a + b, 0) * p.gravity * p.lengths[i] * Math.cos(s[i + 1]);
  return e;
}
export function isBalanced(s: State, p: Physics): boolean {
  const n = p.lengths.length + 1;
  return Math.abs(s[0]) < p.rail && s.slice(1, n).every(a => Math.abs(degrees(a)) < 12) && s.slice(n + 1).every(w => Math.abs(w) < 1);
}
export function finishReason(s: State, p: Physics, task: Task, time: number, limit = 30): string | null {
  if (s.some(v => !Number.isFinite(v))) return '수치 계산 오류';
  if (Math.abs(s[0]) >= p.rail) return '수레가 레일 한계에 도달했습니다';
  if (task === 'balance' && s.slice(1, p.lengths.length + 1).some(a => Math.abs(degrees(a)) > 12)) return '막대가 균형 범위 ±12°를 벗어났습니다';
  if (time + 1e-8 >= limit) return '설정한 실험 시간이 끝났습니다';
  return null;
}

