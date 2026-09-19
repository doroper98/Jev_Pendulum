import { DT, clamp, finishReason, initialState, isBalanced, massMatrix, parameters, solve, type State, type Task, type Topology, step } from './physics.ts';
import { ARCHITECTURES, requestBody, validJevAnswer, type Architecture, type JevAnswer, type LayerDecision, type Memory, type Observation } from './jev.ts';
import { LocalController, type LocalControl } from './local-controller.ts';
import { addUsage, emptyUsage, usageFromDecisions, validUsage, type UsageTotals } from './usage.ts';

export type Controller = 'jev' | 'local' | 'manual' | 'random';
export interface Config { topology: Topology; task: Task; controller: Controller; architecture: Architecture; clock: 'wait' | 'realtime'; force: number; delay: number; duration: number; seed: number; representation: 'numeric' | 'described'; }
export const DEFAULT_CONFIG: Config = { topology: 'single', task: 'swingup', controller: 'jev', architecture: 'single', clock: 'wait', force: 10, delay: 0, duration: 30, seed: 42, representation: 'numeric' };
export interface Decision { id: number; observedAt: number; appliedAt: number; observation: State; force: number; action: string; model: string; latency: number; phase: string; local?: LocalControl; probabilities?: { LEFT: number; RIGHT: number }; confidence?: number; serverLatencyMs?: number; layers?: LayerDecision[]; calls?: number; nodeCount?: number; inputTokens?: number | null; outputTokens?: number | null; }
export interface Frame { time: number; state: State; force: number; balance: number; wall: number; controlForce?: number; disturbanceForce?: number; }
export interface Recording { version: 1; createdAt: string; config: Config; frames: Frame[]; decisions: Decision[]; events: { time: number; type: string }[]; usage?: UsageTotals; }
export class Experiment {
  config: Config;
  state: State;
  time = 0; wall = 0; force = 0; frameRate = 0; running = false; pending = false;
  balance = 0; bestBalance = 0; reason = ''; error = ''; decisions: Decision[] = []; frames: Frame[] = [];
  events: Recording['events'] = [];
  usage = emptyUsage(); sessionUsage = emptyUsage();
  manual = 0;
  pushForce = 0; dragTarget: number | null = null; disturbanceForce = 0;
  replay: Recording | null = null;
  replayIndex = 0;
  private p; private randomSeed: number; private epoch = 0;
  private local: LocalController | null = null;
  private abort: AbortController | null = null;
  private lastRequest = -Infinity; private accumulator = 0; private lastFrame = 0; private raf = 0;
  private listeners = new Set<() => void>(); private lastNotify = 0;
  constructor(config = DEFAULT_CONFIG) {
    this.config = { ...config }; this.p = parameters(config.topology);
    this.state = initialState(config.topology, config.task, config.seed); this.randomSeed = config.seed;
    this.frames.push(this.frame());
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  // Canvas reads physical state on its own animation loop. React telemetry needs only 10 Hz.
  private notify(force = false, now = performance.now()) { if (force || now - this.lastNotify >= 100) { this.lastNotify = now; this.listeners.forEach(fn => fn()); } }
  private get synchronousControl() { return this.config.controller !== 'jev' && this.config.delay === 0; }
  /** Render interpolation only: one fixed step behind, no predicted/corrected physics. */
  displayState(): State {
    if (!this.running || (!this.replay && this.config.clock === 'wait' && !this.synchronousControl)) return this.state;
    const index = this.replay ? this.replayIndex : this.frames.length - 1;
    if (index < 1) return this.state;
    const before = this.frames[index - 1].state, current = this.frames[index].state;
    const alpha = clamp(this.accumulator / DT, 0, 1);
    return current.map((value, i) => before[i] + (value - before[i]) * alpha);
  }
  frame(): Frame { return { time: this.time, state: [...this.state], force: this.force + this.disturbanceForce, controlForce: this.force, disturbanceForce: this.disturbanceForce, balance: this.balance, wall: this.wall }; }
  private cancel() { this.epoch++; this.abort?.abort(); this.abort = null; this.pending = false; this.local?.suspend(); }
  pause() { this.running = false; this.releaseCart(); this.cancel(); cancelAnimationFrame(this.raf); this.accumulator = 0; this.notify(true); }
  stop() { this.pause(); this.manual = 0; }
  restart() { if (this.replay) this.seek(0); else this.reset(); return this.start(); }
  reset(config = this.config) {
    this.pause(); this.local?.dispose(); this.local = null; this.config = { ...config }; this.p = parameters(config.topology);
    this.state = initialState(config.topology, config.task, config.seed); this.randomSeed = config.seed;
    this.time = this.wall = this.force = this.balance = this.bestBalance = this.frameRate = this.disturbanceForce = 0;
    this.usage = emptyUsage();
    this.error = this.reason = ''; this.frames = [this.frame()]; this.decisions = []; this.events = []; this.replay = null; this.replayIndex = 0; this.manual = 0; this.lastRequest = -Infinity; this.notify(true);
  }
  private async prepareLocal() {
    if (this.replay || this.config.controller !== 'local' || this.local?.ready) return true;
    const epoch = this.epoch; this.local ??= new LocalController(this.config.topology, this.config.force);
    this.pending = true; this.notify(true);
    try { await this.local.initialize(this.state, this.time); return epoch === this.epoch && this.local.ready; }
    catch (error) { if (epoch === this.epoch) this.error = error instanceof Error ? error.message : '로컬 탐색을 시작하지 못했습니다.'; return false; }
    finally { if (epoch === this.epoch) { this.pending = false; this.notify(true); } }
  }
  async start() { if (this.running || this.pending || this.reason) return; this.error = ''; if (this.config.controller === 'local' && !this.replay && !this.local?.ready && !await this.prepareLocal()) return; this.running = true; this.lastFrame = performance.now(); this.raf = requestAnimationFrame(this.tick); this.notify(true); }
  private tick = (now: number) => {
    if (!this.running) return;
    const elapsed = (now - this.lastFrame) / 1000; this.lastFrame = now; this.wall += elapsed;
    if (elapsed > .5) { this.error = '화면 처리 지연으로 일시정지했습니다. 재개해 주세요.'; this.pause(); return; }
    if (elapsed > 0) this.frameRate = this.frameRate ? this.frameRate * .9 + .1 / elapsed : 1 / elapsed;
    if (this.replay) {
      this.accumulator += elapsed;
      while (this.accumulator + 1e-9 >= DT && this.replayIndex < this.replay.frames.length - 1) { this.accumulator -= DT; this.seek(this.replayIndex + 1, false); }
      if (this.replayIndex >= this.replay.frames.length - 1) { this.pause(); return; }
    } else if (this.synchronousControl) {
      // Preserve fractional frame time and catch up with fixed 20ms physics steps.
      // Each step gets its own fresh force, independent of display refresh rate.
      this.accumulator += elapsed;
      while (this.accumulator + 1e-9 >= DT && this.running) { this.accumulator -= DT; void this.decide(true); }
    } else if (this.config.clock === 'wait') {
      this.accumulator = Math.min(this.accumulator + elapsed, DT);
      if (this.accumulator >= DT && !this.pending && this.requestReady(now)) { this.accumulator = 0; void this.decide(true); }
    } else {
      if (!this.pending && this.requestReady(now)) void this.decide(false);
      this.accumulator += elapsed;
      while (this.accumulator + 1e-9 >= DT && this.running) { this.accumulator -= DT; this.advance(); }
    }
    this.notify(false, now);
    if (this.running) this.raf = requestAnimationFrame(this.tick);
  };
  private requestReady(now: number) { return now - this.lastRequest >= (this.config.controller === 'jev' ? (this.config.architecture === 'single' ? 100 : 200) : 19); }
  async singleStep() {
    if (this.running || this.pending || this.reason) return;
    if (this.replay) { this.seek(Math.min(this.replayIndex + 1, this.replay.frames.length - 1)); return; }
    if (!this.requestReady(performance.now())) return;
    this.error = '';
    if (this.config.controller === 'local' && !this.local?.ready && !await this.prepareLocal()) return;
    const start = performance.now(), activeFrames = this.frames;
    await this.decide(true);
    if (activeFrames !== this.frames) return;
    this.wall += (performance.now() - start) / 1000;
    if (this.frames.at(-1)?.time === this.time) this.frames[this.frames.length - 1].wall = this.wall;
    this.notify(true);
  }
  private async decide(advance: boolean) {
    this.pending = true; const epoch = this.epoch, started = performance.now(); this.lastRequest = started;
    const observedAt = this.time, observation = [...this.state]; this.abort = new AbortController(); const signal = this.abort.signal;
    if (!this.synchronousControl) this.notify(true);
    try {
      let force = 0, phase = '', model = '', answer: JevAnswer | undefined, local: LocalControl | undefined;
      if (this.config.controller === 'jev') {
        // Keep the run reference: late receipts still count in the page total,
        // but never become charges for a newly reset experiment.
        const runUsage = this.usage;
        runUsage.unresolvedRequests++; this.sessionUsage.unresolvedRequests++;
        const body: Observation = { topology: this.config.topology, task: this.config.task, state: observation, time: observedAt, force: this.config.force, representation: this.config.representation, architecture: this.config.architecture, history: this.memory() };
        const response = await fetch('/api/jev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
        const data = await response.json();
        const rawUsage = data && typeof data === 'object' && 'usage' in data ? data.usage : undefined;
        const receipt = validUsage(rawUsage) ? rawUsage : response.ok && validJevAnswer(data) ? usageFromDecisions([data]) : !response.ok && [400, 403, 413, 503].includes(response.status) ? emptyUsage() : null;
        if (receipt) {
          runUsage.unresolvedRequests--; this.sessionUsage.unresolvedRequests--;
          addUsage(runUsage, receipt); addUsage(this.sessionUsage, receipt);
          this.notify(true);
        }
        if (!response.ok) { const error = data && typeof data === 'object' && 'error' in data ? data.error : null; throw new Error(typeof error === 'string' ? error : 'Jev 요청이 실패했습니다.'); }
        if (!validJevAnswer(data)) throw new Error('유효하지 않은 제어 응답입니다.');
        answer = data; force = answer.action === 'RIGHT' ? this.config.force : -this.config.force; model = answer.model; phase = 'Jev Choice';
      } else if (this.config.controller === 'local') {
        if (!this.local?.ready) throw new Error('먼저 현재 상태의 제어 계획을 계산해 주세요.');
        local = this.local.control(observation, observedAt);
        force = local.force; phase = local.phase; model = 'local-online-mpc-v2';
      } else if (this.config.controller === 'random') {
        this.randomSeed = (Math.imul(this.randomSeed, 1664525) + 1013904223) >>> 0;
        force = this.randomSeed / 4294967296 < .5 ? -this.config.force : this.config.force; model = 'seeded-random-v1'; phase = '시드 고정 무작위';
      } else { force = this.manual * this.config.force; model = 'human'; phase = '수동 입력'; }
      if (this.config.delay > 0) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.config.delay);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
      if (epoch !== this.epoch) return;
      this.force = force;
      this.decisions.push({ id: this.decisions.length + 1, observedAt, appliedAt: this.time, observation, force, action: force > .001 ? 'RIGHT' : force < -.001 ? 'LEFT' : 'HOLD', model, latency: performance.now() - started, phase, ...(local ? { local } : {}), ...(answer ? { probabilities: answer.probabilities, confidence: answer.confidence, serverLatencyMs: answer.serverLatencyMs, layers: answer.layers, calls: answer.calls, nodeCount: answer.nodeCount, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens } : { calls: 0, inputTokens: 0, outputTokens: 0 }) });
      if (advance) this.advance();
    } catch (error) { if (epoch === this.epoch) { this.error = error instanceof Error ? error.message : '제어 요청에 실패했습니다.'; this.pause(); } }
    finally { if (epoch === this.epoch) { this.pending = false; this.abort = null; if (!this.running || !this.synchronousControl) this.notify(true); } }
  }
  private advance() {
    this.disturbanceForce = this.dragTarget === null ? this.pushForce : clamp(35 * (this.dragTarget - this.state[0]) - 5 * this.state[this.p.lengths.length + 1], -20, 20);
    this.state = step(this.state, this.force + this.disturbanceForce, this.p); this.time = Math.round((this.time + DT) * 100000) / 100000;
    this.balance = isBalanced(this.state, this.p) ? this.balance + DT : 0; this.bestBalance = Math.max(this.bestBalance, this.balance);
    this.frames.push(this.frame());
    const reason = finishReason(this.state, this.p, this.config.task, this.time, this.config.duration);
    if (reason) { this.reason = reason; this.pause(); }
  }
  pushCart(force: number) {
    if (!this.running || this.replay || !Number.isFinite(force)) return;
    this.dragTarget = null; this.pushForce = clamp(force, -12, 12);
    this.events.push({ time: this.time, type: `user cart force ${this.pushForce} N` }); this.notify(true);
  }
  dragCart(target: number) {
    if (!this.running || this.replay || !Number.isFinite(target)) return;
    if (this.dragTarget === null) this.events.push({ time: this.time, type: 'user cart drag start; force limited to 20 N' });
    this.pushForce = 0; this.dragTarget = clamp(target, -this.p.rail, this.p.rail);
  }
  releaseCart() {
    if (this.dragTarget !== null || this.pushForce !== 0) this.events.push({ time: this.time, type: 'user cart force released' });
    this.pushForce = 0; this.dragTarget = null;
  }
  disturb(kind: 'cart' | 'pole') {
    if (this.replay || this.reason || (this.pending && this.config.clock === 'wait')) return;
    const n = this.p.lengths.length + 1;
    const impulse = Array(n).fill(0); impulse[kind === 'cart' ? 0 : 1] = kind === 'cart' ? .4 : .12;
    const delta = solve(massMatrix(this.state, this.p), impulse);
    this.state = this.state.map((v, i) => i < n ? v : v + delta[i - n]);
    this.events.push({ time: this.time, type: kind === 'cart' ? 'cart impulse +0.4 N s' : 'pole1 angular impulse +0.12 N m s' }); this.notify(true);
  }
  export(): Recording { return { version: 1, createdAt: new Date().toISOString(), config: { ...this.config }, frames: this.frames, decisions: this.decisions, events: this.events, usage: { ...this.usage } }; }
  load(recording: Recording) { this.reset(recording.config); this.replay = recording; this.frames = recording.frames; this.decisions = recording.decisions; this.events = recording.events; this.usage = { ...(recording.usage ?? usageFromDecisions(recording.decisions)) }; this.seek(0); }
  seek(index: number, pause = true) {
    if (!this.replay) return; if (pause) this.pause();
    this.replayIndex = Math.max(0, Math.min(Math.floor(index), this.replay.frames.length - 1));
    const frame = this.replay.frames[this.replayIndex]; this.state = [...frame.state]; this.time = frame.time; this.force = frame.controlForce ?? frame.force; this.disturbanceForce = frame.disturbanceForce ?? 0; this.balance = frame.balance; this.wall = frame.wall; this.reason = ''; this.notify();
  }
  private memory(): Memory[] { return this.config.architecture === 'recurrent' ? this.decisions.slice(-3).filter(d => d.action === 'LEFT' || d.action === 'RIGHT').map(d => ({ time: d.observedAt, state: d.observation, action: d.action as 'LEFT' | 'RIGHT', signals: Object.fromEntries((d.layers || []).flatMap(l => l.nodes).map(node => [node.id, node.choice])) })) : []; }
  inputPreview() { return requestBody({ topology: this.config.topology, task: this.config.task, state: this.state, time: this.time, force: this.config.force, representation: this.config.representation, architecture: this.config.architecture, history: this.memory() }); }
  dispose() { this.pause(); this.local?.dispose(); this.listeners.clear(); }
}

export function parseRecording(text: string): Recording {
  if (text.length > 15000000) throw new Error('15MB 이하의 실험 파일을 선택하세요.');
  const r = JSON.parse(text) as Recording, c = r?.config;
  if (r?.version !== 1 || !c || !['single', 'double'].includes(c.topology) || !['balance', 'swingup'].includes(c.task) || !['jev', 'local', 'random', 'manual'].includes(c.controller) || !Object.hasOwn(ARCHITECTURES, c.architecture) || !['wait', 'realtime'].includes(c.clock) || !['numeric', 'described'].includes(c.representation) || !Number.isInteger(c.seed) || !Number.isFinite(c.force) || c.force < 2 || c.force > 20 || !Number.isFinite(c.delay) || c.delay < 0 || c.delay > 1000 || !Number.isFinite(c.duration) || c.duration < 1 || c.duration > 120) throw new Error('지원하지 않는 실험 파일입니다.');
  const n = c.topology === 'single' ? 4 : 6;
  if (!Array.isArray(r.frames) || !r.frames.length || r.frames.length > 6100 || r.frames.some((f, i) => !Array.isArray(f.state) || f.state.length !== n || !f.state.every(Number.isFinite) || ![f.time, f.force, f.balance, f.wall].every(Number.isFinite) || f.time < 0 || (i > 0 && f.time < r.frames[i - 1].time))) throw new Error('유효하지 않은 상태 기록입니다.');
  if (r.frames.some(f => (f.controlForce !== undefined && !Number.isFinite(f.controlForce)) || (f.disturbanceForce !== undefined && !Number.isFinite(f.disturbanceForce)))) throw new Error('유효하지 않은 외력 기록입니다.');
  if (!Array.isArray(r.decisions) || r.decisions.length > 10000 || r.decisions.some(d => !d || typeof d.model !== 'string' || typeof d.phase !== 'string' || !['LEFT', 'RIGHT', 'HOLD'].includes(d.action) || ![d.id, d.observedAt, d.appliedAt, d.force, d.latency].every(Number.isFinite) || !Array.isArray(d.observation) || d.observation.length !== n || !d.observation.every(Number.isFinite) || (d.probabilities !== undefined && (!Number.isFinite(d.probabilities?.LEFT) || !Number.isFinite(d.probabilities?.RIGHT))))) throw new Error('유효하지 않은 판단 기록입니다.');
  if (r.decisions.some(d => d.layers && !validJevAnswer({ ...d, action: d.action, calls: d.calls, nodeCount: d.nodeCount }))) throw new Error('유효하지 않은 네트워크 판단입니다.');
  if (r.decisions.some(d => d.local && (!Array.isArray(d.local.reference) || d.local.reference.length !== n || !d.local.reference.every(Number.isFinite) || ![d.local.force, d.local.feedforward, d.local.feedback].every(Number.isFinite) || typeof d.local.saturated !== 'boolean' || typeof d.local.phase !== 'string'))) throw new Error('유효하지 않은 로컬 제어 기록입니다.');
  if (!Array.isArray(r.events)) r.events = [];
  if (r.usage !== undefined && !validUsage(r.usage)) throw new Error('유효하지 않은 사용량 기록입니다.');
  return r;
}
