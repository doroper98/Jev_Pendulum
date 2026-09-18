"""Offline force trajectory optimization; only the generated feedback policy ships.

Requires casadi, numpy, scipy. The browser ALWAYS integrates lib/physics.ts;
reference states are control targets, never animation frames or state overrides.
Run: python scripts/generate-local-plans.py
"""
from pathlib import Path
import json
import casadi as ca
import numpy as np
from scipy.linalg import solve_discrete_are


def dynamics(topology):
    lengths, masses = ([1.5], [.2]) if topology == 'single' else ([.85, .75], [.15, .12])
    n = len(lengths) + 1
    s, u = ca.SX.sym('s', n * 2), ca.SX.sym('u')
    suffix = lambda i: sum(masses[i:])
    m, rhs = ca.SX.zeros(n, n), ca.SX.zeros(n)
    m[0, 0], rhs[0] = 1 + suffix(0), u - .06 * s[n]
    for i in range(1, n):
        li = lengths[i - 1]
        m[0, i] = m[i, 0] = suffix(i - 1) * li * ca.cos(s[i])
        rhs[0] += suffix(i - 1) * li * ca.sin(s[i]) * s[n + i] ** 2
        rhs[i] = suffix(i - 1) * 9.81 * li * ca.sin(s[i])
        for j in range(1, n):
            c = suffix(max(i, j) - 1) * li * lengths[j - 1]
            m[i, j] = c * ca.cos(s[i] - s[j])
            rhs[i] -= c * ca.sin(s[i] - s[j]) * s[n + j] ** 2
    rhs[1] -= .002 * s[n + 1]
    if n == 3:
        torque = .002 * (s[n + 2] - s[n + 1])
        rhs[1] += torque
        rhs[2] -= torque
    f = ca.Function('f', [s, u], [ca.vertcat(s[n:], ca.solve(m, rhs))])
    y = s
    for _ in range(4):
        h = .005
        k1 = f(y, u)
        k2 = f(y + h / 2 * k1, u)
        k3 = f(y + h / 2 * k2, u)
        k4 = f(y + h * k3, u)
        y = y + h / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
    return n, ca.Function('step', [s, u], [y]), ca.Function('linearize', [s, u], [ca.jacobian(y, s), ca.jacobian(y, u)])


def plan(topology):
    n, step, jac = dynamics(topology)
    duration = 6 if n == 2 else 8
    count = int(duration / .04)
    opt = ca.Opti()
    x, u = opt.variable(n * 2, count + 1), opt.variable(1, count)
    start = np.array([0, np.pi - .02] + ([np.pi + .03] if n == 3 else []) + [0] * n)
    opt.subject_to(x[:, 0] == start)
    opt.subject_to(x[:, -1] == 0)
    opt.subject_to(opt.bounded(-1.9, x[0, :], 1.9))
    opt.subject_to(opt.bounded(-8, u, 8))
    for k in range(count):
        opt.subject_to(x[:, k + 1] == step(step(x[:, k], u[k]), u[k]))
    opt.minimize(.04 * (ca.sumsqr(u) + .1 * ca.sumsqr(x[0, :]) + .005 * ca.sumsqr(x[n:, :])) + .05 * ca.sumsqr(u[:, 1:] - u[:, :-1]))
    guess = np.outer(start, (1 + np.cos(np.linspace(0, np.pi, count + 1))) / 2)
    opt.set_initial(x, guess)
    opt.solver('ipopt', {'expand': True}, {'print_level': 0, 'max_iter': 2500, 'tol': 1e-8})
    sol = opt.solve()
    force = np.repeat(np.asarray(sol.value(u)).flatten(), 2)
    # Use the feasible shooting solution at 20ms, avoiding accumulated open-loop drift.
    coarse = np.asarray(sol.value(x)).T
    states = []
    for k in range(count):
        states.extend([coarse[k], np.asarray(step(coarse[k], force[2 * k])).flatten()])
    states.append(coarse[-1])
    q = np.diag([10] + [60] * (n - 1) + [4] + [3] * (n - 1))
    r = .15
    a, b = map(np.asarray, jac(np.zeros(n * 2), 0))
    p = solve_discrete_are(a, b, q, np.array([[r]]))
    upright = (b.T @ p @ a / (r + b.T @ p @ b)).flatten()
    gains = []
    for k in reversed(range(len(force))):
        a, b = map(np.asarray, jac(states[k], force[k]))
        gain = b.T @ p @ a / (r + b.T @ p @ b)
        p = q + a.T @ p @ a - a.T @ p @ b @ gain
        p = (p + p.T) / 2
        gains.append(gain.flatten().tolist())
    result = {'dt': .02, 'duration': duration, 'upright': upright.tolist(), 'states': [s.tolist() for s in states], 'forces': force.tolist(), 'gains': gains[::-1]}
    print(topology, 'solved', 'peak force', max(abs(force)), 'cart', max(abs(coarse[:, 0])), flush=True)
    return result


if __name__ == '__main__':
    out = Path(__file__).resolve().parents[1] / 'lib' / 'local-plans.json'
    plans = {topology: plan(topology) for topology in ['single', 'double']}
    out.write_text(json.dumps(plans, separators=(',', ':')), encoding='utf-8')
