import { runPlanner, type PlannerRequest, type PlannerResult } from './planner-job.ts';
export interface PlannerClient { solve(request: PlannerRequest): Promise<PlannerResult>; cancel(): void; }
export class BrowserPlanner implements PlannerClient {
  private worker: Worker | null = null;
  private reject: ((reason: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  async solve(request: PlannerRequest): Promise<PlannerResult> {
    // Headless numerical tests use exactly the same optimizer. Browsers use a Worker.
    if (typeof Worker === 'undefined') return runPlanner(request);
    this.worker ??= new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      const finish = () => { clearTimeout(this.timer); this.reject = null; };
      worker.onmessage = event => { finish(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result); };
      worker.onerror = () => { finish(); reject(new Error('로컬 계산 스레드를 시작하지 못했습니다. 새로고침 후 다시 시도하세요.')); };
      this.timer = setTimeout(() => { this.cancel(); }, 30000);
      worker.postMessage(request);
    });
  }
  cancel() { clearTimeout(this.timer); this.worker?.terminate(); this.worker = null; this.reject?.(new Error('로컬 계산이 중단되었습니다.')); this.reject = null; }
}
