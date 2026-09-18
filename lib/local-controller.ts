import plans from './local-plans.json' with { type: 'json' };
import { clamp, wrap, type State, type Task, type Topology } from './physics.ts';

export interface LocalControl {
  force: number;
  phase: string;
  feedforward: number;
  feedback: number;
  saturated: boolean;
  reference: State;
}

/** Independent, explicitly selected controller. Returns a cart force only.
 * Swing-up: offline constrained trajectory + time-varying LQR feedback.
 * Balance: discrete LQR about the upright equilibrium. No Jev calls.
 * References are targets for feedback, NEVER replacement physical states.
 */
export function localControl(topology: Topology, task: Task, state: State, time: number, limit: number): LocalControl {
  const plan = plans[topology], n = state.length / 2;
  const tracking = task === 'swingup' && time < plan.duration - 1e-8;
  const k = Math.min(plan.forces.length - 1, Math.max(0, Math.floor((time + 1e-8) / plan.dt)));
  const reference = tracking ? plan.states[k] : Array(state.length).fill(0);
  const gain = tracking ? plan.gains[k] : plan.upright;
  const error = state.map((value, i) => i > 0 && i < n ? wrap(value - reference[i]) : value - reference[i]);
  const feedforward = tracking ? plan.forces[k] : 0;
  const feedback = -gain.reduce((sum, value, i) => sum + value * error[i], 0);
  const force = clamp(feedforward + feedback, -limit, limit);
  return { force, phase: tracking ? '궤적 추종 · TVLQR' : '직립 균형 · LQR', feedforward, feedback, saturated: Math.abs(feedforward + feedback) > limit, reference: [...reference] };
}
