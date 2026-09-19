import type { Recording } from './experiment.ts';
import { degrees } from './physics.ts';
import { usageFromDecisions } from './usage.ts';
export function summarize(recording: Recording) {
  const frames = recording.frames, decisions = recording.decisions, last = frames.at(-1)!;
  let travel = 0, switches = 0;
  for (let i = 1; i < frames.length; i++) travel += Math.abs(frames[i].state[0] - frames[i - 1].state[0]);
  for (let i = 1; i < decisions.length; i++) if (decisions[i].action !== decisions[i - 1].action) switches++;
  const bestBalance = Math.max(...frames.map(f => f.balance));
  const tokenKnown = decisions.every(d => typeof d.inputTokens === 'number');
  const usage = recording.usage ?? usageFromDecisions(decisions);
  return { config: { ...recording.config }, elapsed: last.time, bestBalance, success: bestBalance >= 2, maxAngle: Math.max(...frames.flatMap(f => f.state.slice(1, recording.config.topology === 'single' ? 2 : 3).map(a => Math.abs(degrees(a))))), travel, switches, calls: decisions.reduce((s, d) => s + (d.calls || 0), 0), inputTokens: tokenKnown ? decisions.reduce((s, d) => s + (d.inputTokens || 0), 0) : null, meanLatency: decisions.length ? decisions.reduce((s, d) => s + d.latency, 0) / decisions.length : 0, steps: decisions.length, usage };
}
