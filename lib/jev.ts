import { degrees, DT, parameters, type State, type Task, type Topology } from './physics.ts';

export type Architecture = 'single' | 'serial' | 'bundle' | 'recurrent';
export const ARCHITECTURES = {
  single: { label: '단일 Jev', detail: '상태 → 행동', layers: 1, nodes: 1, calls: 1 },
  serial: { label: '직렬 3단', detail: '관찰 → 전략 → 행동', layers: 3, nodes: 3, calls: 3 },
  bundle: { label: '병렬 묶음', detail: '감각 3 → 행동 1', layers: 2, nodes: 4, calls: 2 },
  recurrent: { label: '순환 다층', detail: '감각 3 → 통합 2 → 행동 1 ↺', layers: 3, nodes: 6, calls: 3 },
} as const;
export interface Memory { time: number; state: State; action: 'LEFT' | 'RIGHT'; signals: Record<string, string>; }
export interface Observation { topology: Topology; task: Task; state: State; force: number; representation: 'numeric' | 'described'; time: number; architecture: Architecture; history?: Memory[]; }
export function validObservation(value: unknown): value is Observation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>, n = v.topology === 'single' ? 4 : 6;
  const stateOK = (s: unknown) => Array.isArray(s) && s.length === n && s.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 10000);
  const historyOK = v.history === undefined || (Array.isArray(v.history) && v.history.length <= 3 && v.history.every(h => h && typeof h === 'object' && Number.isFinite(h.time) && h.time >= 0 && stateOK(h.state) && (h.action === 'LEFT' || h.action === 'RIGHT') && h.signals && typeof h.signals === 'object' && Object.keys(h.signals).length <= 8 && Object.entries(h.signals).every(([key, val]) => key.length < 40 && typeof val === 'string' && /^[A-Z_]{1,40}$/.test(val))));
  return (v.topology === 'single' || v.topology === 'double') && (v.task === 'balance' || v.task === 'swingup') &&
    typeof v.architecture === 'string' && Object.hasOwn(ARCHITECTURES, v.architecture) &&
    (v.representation === 'numeric' || v.representation === 'described') && stateOK(v.state) && historyOK &&
    typeof v.force === 'number' && v.force >= 2 && v.force <= 20 && typeof v.time === 'number' && Number.isFinite(v.time) && v.time >= 0;
}
export interface Question { type: 'choice'; instructions: string; criteria: Record<string, string>; }
export interface NodeDecision { id: string; label: string; choice: string; probabilities: Record<string, number>; confidence: number; }
export interface LayerDecision { id: number; name: string; latencyMs: number; model: string; nodes: NodeDecision[]; }
export interface JevAnswer {
  action: 'LEFT' | 'RIGHT'; probabilities: { LEFT: number; RIGHT: number }; confidence: number; model: string; serverLatencyMs: number;
  layers: LayerDecision[]; calls: number; nodeCount: number; inputTokens: number | null; outputTokens: number | null;
}
export function physicalState(o: Observation) {
  const p = parameters(o.topology), n = p.lengths.length + 1;
  return {
    experiment: o.topology === 'single' ? 'cart with one passive pendulum' : 'cart with two serial passive links and one free elbow joint',
    goal: o.task === 'balance' ? 'Keep all links upright and the cart inside the rail.' : 'Swing all links up from hanging down, then balance upright. Stay inside the rail.',
    conventions: 'Positive x/velocity/force is right. Angles are ABSOLUTE from vertical UP, positive clockwise. Zero degrees is upright; 180 is hanging down. All joints are passive. There is no auxiliary controller. Only the final LEFT/RIGHT choice applies force to the cart.',
    physics: { ...p, controlStepSeconds: DT, forceMagnitudeN: o.force, realtimeWaiting: 'The previous force is held while awaiting the whole network response.' },
    timeSeconds: o.time, cart: { xM: o.state[0], velocityMps: o.state[n] },
    links: p.lengths.map((_, i) => ({ absoluteAngleDeg: degrees(o.state[i + 1]), angularVelocityRadps: o.state[n + i + 1] })),
    ...(o.representation === 'described' ? { description: p.lengths.map((_, i) => `Link ${i + 1}: ${Math.abs(degrees(o.state[i + 1])).toFixed(2)} degrees ${degrees(o.state[i + 1]) >= 0 ? 'clockwise' : 'counterclockwise'} from UP, rotating ${o.state[n + i + 1] >= 0 ? 'clockwise' : 'counterclockwise'} at ${Math.abs(o.state[n + i + 1]).toFixed(3)} rad/s.`).join(' ') } : {}),
  };
}
const choice = (instructions: string, criteria: Record<string, string>): Question => ({ type: 'choice', instructions, criteria });
export const SENSORY = {
  stability: choice('What is the current posture of the passive pendulum links relative to the upright goal?', { NEAR_UPRIGHT: 'All links near upright.', DEVIATING: 'Some links substantially away from upright.', HANGING: 'Links predominantly hanging below their pivots.' }),
  motion: choice('What is the dominant current rotational motion of the pendulum links?', { CLOCKWISE: 'Predominantly clockwise.', COUNTERCLOCKWISE: 'Predominantly counterclockwise.', MIXED: 'Links rotate in opposing directions.', STILL: 'Little rotational movement.' }),
  rail: choice('Which rail-related position and velocity condition describes the cart?', { LEFT_RISK: 'Near or moving toward the left boundary.', RIGHT_RISK: 'Near or moving toward the right boundary.', INTERIOR: 'Away from either boundary and not moving quickly toward one.' }),
};
const STRATEGY = choice('Given the physical state and earlier Jev judgments, which immediate control objective is appropriate? Your choice is advice to a later Jev, not a preprogrammed controller.', { BUILD_SWING: 'Build an upward swing.', CATCH_UPRIGHT: 'Catch the links approaching upright.', MAINTAIN_UPRIGHT: 'Maintain upright balance.', RECOVER_RAIL: 'Recover from approaching the rail boundary.' });
const EFFECT = choice('Compare the prior observations and actions with the present state. Did the last action improve progress toward the goal while respecting the rail? Use UNCLEAR if history is absent or insufficient.', { IMPROVED: 'Progress appears better.', WORSENED: 'Progress appears worse.', UNCLEAR: 'Insufficient or ambiguous evidence.' });
const NODE_LABELS: Record<string, string> = { stability: '자세', motion: '회전 방향', rail: '레일 위험', strategy: '전략', effect: '이전 행동 효과', action: '최종 행동' };
export function actionQuestion(force: number): Question {
  return choice('Which horizontal force on the CART should be applied next to achieve the stated goal? Consider cart position/velocity, all link angles/velocities, and any prior Jev judgments. Those judgments may be wrong. Decide the force direction yourself; no external controller will correct it.', { LEFT: `Apply ${-force} newtons to the cart (left).`, RIGHT: `Apply ${force} newtons to the cart (right).` });
}
export interface EvaluationRequest { model: string; state: unknown; questions: Record<string, Question>; }
export function requestBody(o: Observation, model = 'jev-latest'): EvaluationRequest {
  const questions: Record<string, Question> = o.architecture === 'single' ? { action: actionQuestion(o.force) } : o.architecture === 'serial' ? { stability: SENSORY.stability } : SENSORY;
  return { model, state: { physical: physicalState(o), ...(o.architecture === 'recurrent' ? { previousSteps: o.history || [] } : {}) }, questions };
}
export function parseNodes(value: unknown, questions: Record<string, Question>) {
  if (!value || typeof value !== 'object') throw new Error('Jev 응답 형식이 올바르지 않습니다.');
  const root = value as Record<string, unknown>;
  if (typeof root.model !== 'string' || !root.answers || typeof root.answers !== 'object') throw new Error('모델 또는 판단이 누락되었습니다.');
  const answers = root.answers as Record<string, unknown>;
  const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const nodes = Object.entries(questions).map(([id, q]): NodeDecision => {
    const answer = answers[id] as Record<string, unknown> | undefined, probs = answer?.probabilities as Record<string, unknown> | undefined;
    const keys = Object.keys(q.criteria);
    if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || !keys.includes(answer.choice) || !probability(answer.confidence) || !probs || keys.some(key => !probability(probs[key])) || Math.abs(keys.reduce((sum, key) => sum + (probs[key] as number), 0) - 1) > .02) throw new Error('Jev가 유효한 선택 분포를 반환하지 않았습니다.');
    return { id, label: NODE_LABELS[id] || id, choice: answer.choice, probabilities: Object.fromEntries(keys.map(key => [key, probs[key] as number])), confidence: answer.confidence };
  });
  const usage = root.usage as Record<string, unknown> | undefined;
  const tokens = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  return { model: root.model, nodes, inputTokens: tokens(usage?.input_tokens), outputTokens: tokens(usage?.output_tokens) };
}
/** All semantic nodes are real provider questions. Code only packages signals;
 * it never computes a control policy or votes on/replaces the final action. */
export async function evaluateNetwork(o: Observation, model: string, send: (request: EvaluationRequest) => Promise<unknown>): Promise<JevAnswer> {
  const started = performance.now(), layers: LayerDecision[] = [];
  const first = requestBody(o, model), physical = physicalState(o);
  let inputTokens: number | null = 0, outputTokens: number | null = 0;
  const signals: NodeDecision[] = [];
  const evaluate = async (name: string, questions: Record<string, Question>, state: unknown) => {
    const start = performance.now();
    const parsed = parseNodes(await send({ model, questions, state }), questions);
    inputTokens = inputTokens !== null && parsed.inputTokens !== null ? inputTokens + parsed.inputTokens : null;
    outputTokens = outputTokens !== null && parsed.outputTokens !== null ? outputTokens + parsed.outputTokens : null;
    layers.push({ id: layers.length + 1, name, latencyMs: performance.now() - start, model: parsed.model, nodes: parsed.nodes }); signals.push(...parsed.nodes);
    return parsed;
  };
  let last = await evaluate(o.architecture === 'single' ? '직접 행동' : '감각 판단', first.questions, first.state);
  const context = () => ({ physical, priorJevJudgments: [...signals], ...(o.architecture === 'recurrent' ? { previousSteps: o.history || [] } : {}) });
  if (o.architecture === 'serial') await evaluate('전략 판단', { strategy: STRATEGY }, context());
  if (o.architecture === 'recurrent') await evaluate('전략 · 피드백', { strategy: STRATEGY, effect: EFFECT }, context());
  if (o.architecture !== 'single') last = await evaluate('최종 행동', { action: actionQuestion(o.force) }, context());
  const action = last.nodes.find(node => node.id === 'action');
  if (!action || (action.choice !== 'LEFT' && action.choice !== 'RIGHT')) throw new Error('최종 행동이 없습니다.');
  return { action: action.choice, probabilities: { LEFT: action.probabilities.LEFT, RIGHT: action.probabilities.RIGHT }, confidence: action.confidence, model: last.model, serverLatencyMs: performance.now() - started, layers, calls: layers.length, nodeCount: signals.length, inputTokens, outputTokens };
}
export function validJevAnswer(value: unknown): value is JevAnswer {
  if (!value || typeof value !== 'object') return false;
  const a = value as JevAnswer;
  return (a.action === 'LEFT' || a.action === 'RIGHT') && typeof a.model === 'string' && Number.isFinite(a.confidence) && Number.isFinite(a.probabilities?.LEFT) && Number.isFinite(a.probabilities?.RIGHT) && Array.isArray(a.layers) && a.layers.length >= 1 && a.layers.length <= 3 && a.layers.every(l => typeof l.name === 'string' && Number.isFinite(l.latencyMs) && Array.isArray(l.nodes) && l.nodes.every(n => typeof n.id === 'string' && typeof n.choice === 'string' && typeof n.label === 'string' && Number.isFinite(n.confidence))) && Number.isFinite(a.calls) && Number.isFinite(a.nodeCount);
}
