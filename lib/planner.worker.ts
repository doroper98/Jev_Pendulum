import { runPlanner, type PlannerRequest } from './planner-job.ts';
const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<PlannerRequest>) => void) | null; postMessage(value: unknown): void };
worker.onmessage = event => {
  try { worker.postMessage({ result: runPlanner(event.data) }); }
  catch (error) { worker.postMessage({ error: error instanceof Error ? error.message : '로컬 탐색 계산 오류' }); }
};
