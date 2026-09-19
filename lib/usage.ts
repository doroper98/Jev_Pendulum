// Published TypeSafe list price, checked 2026-09-19. This is an estimate,
// not an account balance or invoice (credits, tax and unreturned usage differ).
export const JEV_PRICING = { inputPerMillionUsd: 0.042, outputPerMillionUsd: 0, checkedAt: '2026-09-19', source: 'https://docs.typesafe.ai/models' } as const;
export interface UsageTotals { calls: number; inputTokens: number; outputTokens: number; unreportedCalls: number; unresolvedRequests: number; }
export const emptyUsage = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, unreportedCalls: 0, unresolvedRequests: 0 });
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function validUsage(value: unknown): value is UsageTotals {
  if (!value || typeof value !== 'object') return false;
  const u = value as UsageTotals;
  return [u.calls, u.inputTokens, u.outputTokens, u.unreportedCalls, u.unresolvedRequests].every(count) && u.unreportedCalls <= u.calls;
}
export function addUsage(target: UsageTotals, usage: UsageTotals) {
  for (const key of Object.keys(emptyUsage()) as (keyof UsageTotals)[]) target[key] += usage[key];
}
/** Called after receiving an upstream body, even if its decisions are invalid. */
export function reportedUsage(payload: unknown): UsageTotals {
  const raw = payload && typeof payload === 'object' ? (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage : undefined;
  return { ...emptyUsage(), calls: 1, inputTokens: count(raw?.input_tokens) ? raw.input_tokens : 0, outputTokens: count(raw?.output_tokens) ? raw.output_tokens : 0, unreportedCalls: count(raw?.input_tokens) && count(raw?.output_tokens) ? 0 : 1 };
}
export function usageFromDecisions(decisions: { calls?: number; inputTokens?: number | null; outputTokens?: number | null }[]): UsageTotals {
  const total = emptyUsage();
  for (const d of decisions) {
    const calls = count(d.calls) ? d.calls : 0;
    addUsage(total, { ...emptyUsage(), calls, inputTokens: count(d.inputTokens) ? d.inputTokens : 0, outputTokens: count(d.outputTokens) ? d.outputTokens : 0, unreportedCalls: count(d.inputTokens) && count(d.outputTokens) ? 0 : calls });
  }
  return total;
}
export const estimatedUsd = (usage: UsageTotals) => (usage.inputTokens * JEV_PRICING.inputPerMillionUsd + usage.outputTokens * JEV_PRICING.outputPerMillionUsd) / 1_000_000;
export const usageIncomplete = (usage: UsageTotals) => usage.unreportedCalls > 0 || usage.unresolvedRequests > 0;
export function formatUsd(value: number) { return value > 0 && value < .000001 ? '< $0.000001' : `$${value.toFixed(6)}`; }
