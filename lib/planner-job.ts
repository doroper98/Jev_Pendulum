import { optimize, shiftPlan, type Plan } from './online-planner.ts';
import type { State, Topology } from './physics.ts';
export interface PlannerRequest { topology: Topology; state: State; limit: number; previous?: { plan: Plan; elapsed: number }; }
export interface PlannerResult { plan: Plan; milliseconds: number; }
export function runPlanner(request: PlannerRequest): PlannerResult {
  const started = performance.now();
  const { topology, state, limit, previous } = request;
  const seed = previous ? shiftPlan(previous.plan, previous.elapsed, topology, limit, state) : undefined;
  const plan = optimize(state, topology, limit, seed, previous ? 12 : 200);
  if (!Number.isFinite(plan.cost) || plan.states.length !== plan.forces.length + 1 || plan.states.some(s => s.some(v => !Number.isFinite(v)))) throw new Error('현재 상태에서 유효한 제어 계획을 찾지 못했습니다.');
  return { plan, milliseconds: performance.now() - started };
}
