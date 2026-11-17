import type { MatchmakingGame } from "@tetraboard/protocol";
import { compareWaits, type State } from "./state";

export function orderWaits(r: { game: MatchmakingGame; legacy: boolean }, state: State) {
  state.waiting.sort(
    r.game === "four-reversi" && !r.legacy
      ? (a, b) => a.joinedAtMs - b.joinedAtMs || a.operationId.localeCompare(b.operationId)
      : compareWaits,
  );
}

export function locate(state: State, id: string) {
  const group = state.groups.find((g) => g.players.some((p) => p.accountId === id && !p.released));
  return {
    group,
    wait:
      group?.players.find((p) => p.accountId === id) ??
      state.waiting.find((w) => w.accountId === id),
  };
}
