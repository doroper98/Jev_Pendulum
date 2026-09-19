import { clamp, wrap, type State, type Topology } from './physics.ts';
import { balanceCommand, canCapture, predict, PLAN_DT, type Plan } from './online-planner.ts';
import { BrowserPlanner, type PlannerClient } from './planner-client.ts';

export interface LocalControl {
  force: number; phase: string; feedforward: number; feedback: number;
  saturated: boolean; reference: State;
  mode: 'search' | 'mpc' | 'balance'; replans: number; plannedAt: number;
  planningMs: number; cost: number | null; horizon: number; searching: boolean;
}

/** Every plan is solved from an observed state during THIS run. No saved solutions.
 * Receding-horizon iLQR searches in a Worker; fast feedback uses current observations.
 * Only a cart force is returned. Physical state is never overwritten.
 */
export class LocalController {
  ready = false; searching = false; replans = 0; planningMs = 0; error = '';
  private topology: Topology; private limit: number; private client: PlannerClient;
  private plan: Plan | null = null; private plannedAt = 0; private requestedAt = -Infinity;
  private generation = 0; private balancing = false; private captureCheckedAt = -Infinity;
  constructor(topology: Topology, limit: number, client: PlannerClient = new BrowserPlanner()) { this.topology = topology; this.limit = limit; this.client = client; }
  async initialize(state: State, time: number) {
    if (this.ready) return;
    if (canCapture(state, this.topology, this.limit)) { this.balancing = true; this.ready = true; return; }
    await this.search(state, time);
    if (this.error) throw new Error(this.error);
    this.ready = !!this.plan;
  }
  private async search(state: State, time: number) {
    if (this.searching) return;
    const generation = this.generation; this.searching = true; this.requestedAt = time;
    try {
      const result = await this.client.solve({ topology: this.topology, state: [...state], limit: this.limit, ...(this.plan ? { previous: { plan: this.plan, elapsed: time - this.plannedAt } } : {}) });
      if (generation !== this.generation) return;
      this.replans++; this.planningMs = result.milliseconds;
      if (!this.balancing) { this.plan = result.plan; this.plannedAt = time; }
    } catch (error) { if (generation === this.generation) this.error = error instanceof Error ? error.message : '로컬 재탐색 오류'; }
    finally { if (generation === this.generation) this.searching = false; }
  }
  control(state: State, time: number): LocalControl {
    if (this.error) throw new Error(this.error);
    const n = state.length / 2;
    if (this.balancing && (state.slice(1, n).some(a => Math.abs(wrap(a)) > .8) || state.slice(n + 1).some(v => Math.abs(v) > 6))) { this.balancing = false; this.plan = null; this.requestedAt = -Infinity; }
    if (!this.balancing && time - this.captureCheckedAt >= .1 - 1e-8) {
      this.captureCheckedAt = time;
      if (canCapture(state, this.topology, this.limit)) { this.balancing = true; this.plan = null; }
    }
    let feedforward = 0, feedback = 0, reference: State = Array(state.length).fill(0), mode: LocalControl['mode'] = 'search';
    if (this.balancing) { mode = 'balance'; feedback = balanceCommand(state, this.topology); }
    else {
      if (!this.searching && time - this.requestedAt >= .12 - 1e-8) void this.search(state, time);
      const age = time - this.plannedAt, index = Math.floor((age + 1e-8) / PLAN_DT);
      if (this.plan && index >= 0 && index < this.plan.forces.length) {
        mode = 'mpc'; feedforward = this.plan.forces[index];
        reference = predict(this.plan.states[index], feedforward, this.topology, Math.max(0, age - index * PLAN_DT));
        feedback = this.plan.gains[index].reduce((sum, g, i) => sum + g * (i > 0 && i < n ? wrap(state[i] - reference[i]) : state[i] - reference[i]), 0);
      } else feedback = -2 * state[0] - 3 * state[n];
    }
    const force = clamp(feedforward + feedback, -this.limit, this.limit);
    return { force, phase: mode === 'balance' ? '현재 상태 · 균형 제어' : mode === 'mpc' ? '온라인 MPC · 재계획' : '재탐색 중 · 수레 감쇠', feedforward, feedback, saturated: Math.abs(feedforward + feedback) > this.limit, reference, mode, replans: this.replans, plannedAt: this.plannedAt, planningMs: this.planningMs, cost: this.plan?.cost ?? null, horizon: this.plan ? Math.max(0, this.plan.forces.length * PLAN_DT - (time - this.plannedAt)) : 0, searching: this.searching };
  }
  suspend() { this.generation++; this.client.cancel(); this.searching = false; this.requestedAt = -Infinity; this.error = ''; }
  dispose() { this.suspend(); this.plan = null; this.ready = false; }
}
