import { runPlanner, type PlannerRequest, type PlannerResult } from './planner-job.ts';
export interface PlannerClient { solve(request: PlannerRequest): Promise<PlannerResult>; cancel(): void; }
export class BrowserPlanner implements PlannerClient {
  private worker: Worker | null = null;
  private reject: ((reason: Error) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private createWorker: () => Promise<Worker>;
  private inline: boolean;
  constructor(createWorker?: () => Promise<Worker>) {
    this.inline = typeof Worker === 'undefined' && !createWorker;
    this.createWorker = createWorker ?? (async () => {
      // Vinext rewrites import.meta.url to a build-machine file URL. Let Vite's
      // worker loader generate the public asset URL instead of resolving it here.
      const { default: PlannerWorker } = await import('./planner.worker.ts?worker');
      return new PlannerWorker({ name: 'pendulum-online-planner' });
    });
  }
  async solve(request: PlannerRequest): Promise<PlannerResult> {
    // Headless numerical tests use exactly the same optimizer. Browsers use a Worker.
    if (this.inline) return runPlanner(request);
    const generation = this.generation;
    if (!this.worker) {
      const created = await this.createWorker();
      if (generation !== this.generation) { created.terminate(); throw new Error('로컬 계산이 중단되었습니다.'); }
      this.worker = created;
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      const finish = () => { clearTimeout(this.timer); this.reject = null; };
      worker.onmessage = event => { finish(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result); };
      worker.onerror = () => { finish(); worker.terminate(); this.worker = null; reject(new Error('로컬 계산 스레드를 시작하지 못했습니다. 새로고침 후 다시 시도하세요.')); };
      this.timer = setTimeout(() => { this.cancel(); }, 30000);
      worker.postMessage(request);
    });
  }
  cancel() { this.generation++; clearTimeout(this.timer); this.worker?.terminate(); this.worker = null; this.reject?.(new Error('로컬 계산이 중단되었습니다.')); this.reject = null; }
}
