import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHITECTURES, evaluateNetwork, parseNodes, physicalState, validObservation, validJevAnswer } from '../lib/jev.ts';

const observation = { topology: 'double', task: 'swingup', state: [0, 3.1, 3.2, 0, .1, -.1], time: .02, force: 10, representation: 'numeric', architecture: 'single' };
function response(request) {
  return { model: 'jev-test-contract', usage: { input_tokens: 100, output_tokens: 20 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const keys = Object.keys(q.criteria), selected = id === 'action' ? 'LEFT' : keys[0];
    return [id, { type: 'choice', choice: selected, confidence: .6, probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? .8 : .2 / (keys.length - 1)])) }];
  })) };
}
for (const architecture of Object.keys(ARCHITECTURES)) test(`${architecture}: every layer is evaluated by provider; final action preserved`, async () => {
  const requests = [], history = [{ time: 0, state: [...observation.state], action: 'RIGHT', signals: { rail: 'INTERIOR' } }];
  const result = await evaluateNetwork({ ...observation, architecture, history }, 'jev-latest', async request => { requests.push(structuredClone(request)); return response(request); });
  assert.equal(result.action, 'LEFT'); assert.equal(result.calls, ARCHITECTURES[architecture].calls); assert.equal(result.nodeCount, ARCHITECTURES[architecture].nodes);
  assert.equal(result.inputTokens, requests.length * 100);
  for (const request of requests.slice(1)) assert.ok(request.state.priorJevJudgments.length > 0);
  assert.deepEqual(requests[0].state.physical.cart, { xM: 0, velocityMps: 0 });
  if (architecture === 'recurrent') for (const request of requests) assert.deepEqual(request.state.previousSteps, history);
  else for (const request of requests) assert.ok(!('previousSteps' in request.state));
});
test('intermediate provider failure aborts whole network with no fallback force', async () => {
  let calls = 0;
  await assert.rejects(evaluateNetwork({ ...observation, architecture: 'serial' }, 'jev-latest', async request => { if (++calls === 2) throw new Error('network failure'); return response(request); }), /network failure/);
  assert.equal(calls, 2);
});
test('invalid probabilities are rejected instead of fabricating confidence', () => {
  const questions = { action: { type: 'choice', instructions: '', criteria: { LEFT: '', RIGHT: '' } } };
  const result = response({ questions }); result.answers.action.probabilities.RIGHT = .9;
  assert.throws(() => parseNodes(result, questions));
});
test('input validation and no embedded control policy', () => {
  assert.equal(validObservation(observation), true);
  for (const patch of [{ architecture: 'unknown' }, { state: [0, 0] }, { force: Infinity }, { time: -1 }, { history: Array(4).fill({}) }]) assert.equal(validObservation({ ...observation, ...patch }), false);
  assert.equal(JSON.stringify(physicalState(observation)).includes('recommendedAction'), false);
});
test('recorded network distributions must be present and normalized', async () => {
  const answer = await evaluateNetwork(observation, 'jev-latest', async request => response(request));
  assert.equal(validJevAnswer(answer), true);
  const malformed = structuredClone(answer); delete malformed.layers[0].nodes[0].probabilities;
  assert.equal(validJevAnswer(malformed), false);
  answer.confidence = 3; assert.equal(validJevAnswer(answer), false);
});
