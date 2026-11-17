import type { State, Wait } from "./state";
import type { RatedPolicy } from "./ratedMatchmaking";
export function estimatedMatchAt(
  r: { ratingPolicy?: RatedPolicy; queueRules: { seats: number; fillAfterMs: number } },
  state: State,
  wait: Wait,
  now: number,
  cpuSeats?: number,
) {
  const policy = r.ratingPolicy;
  if (!policy || cpuSeats === undefined || (state.cpuRetryAtMs ?? 0) > now) return;
  const { seats, fillAfterMs } = r.queueRules;
  let cpuMatches = Math.floor(cpuSeats / (seats - 1));
  let eligible = state.waiting.filter(
    (entry) => entry.expiresAtMs > now && (entry.retryAtMs ?? 0) <= now,
  );
  // 実際の補充候補を先頭から読み取り、先行する組が使う対局枠も差し引きます。
  for (let remaining = 4; remaining > 0 && cpuMatches > 0; remaining--) {
    const oldest = eligible[0];
    if (!oldest) return;
    const match = policy.select(eligible, fillAfterMs);
    if (!match) return;
    if (match.selected.some((entry) => entry.operationId === wait.operationId)) {
      const at = oldest.joinedAtMs + fillAfterMs;
      return at > now ? at : undefined;
    }
    if (match.selected.length < seats) cpuMatches--;
    const selected = new Set(match.selected.map((entry) => entry.operationId));
    eligible = eligible.filter((entry) => !selected.has(entry.operationId));
  }
}
