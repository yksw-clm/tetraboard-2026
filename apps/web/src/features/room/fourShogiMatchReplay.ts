import {
  getMatchReplayContract,
  getPublicMatchReplayContract,
  fourShogiPublicStateSchema,
  type ReplayFourShogiMatch,
} from "@tetraboard/protocol";
import { getFourShogiDisplayReplayRules, type FourShogiReplayFrame } from "./fourShogiReplayV1";
import { replayDataEqual } from "./replayDataEqual";
import { fetchEventReplay } from "./fetchEventReplay";
export function fetchFourShogiMatchReplay(
  match: ReplayFourShogiMatch,
  signal: AbortSignal,
): Promise<FourShogiReplayFrame[]> {
  const contract = match.selfPlayerId ? getMatchReplayContract : getPublicMatchReplayContract;
  return fetchEventReplay({
    signal,
    path: (cursor) => `/api${contract.pathFor(match.id)}${cursor ? `?cursor=${cursor}` : ""}`,
    parsePage: (value) => {
      const page = getMatchReplayContract.response.options[0].parse(value);
      if (
        page.matchId !== match.id ||
        page.rulesVersion !== match.replay.rulesVersion ||
        page.eventCount !== match.replay.eventCount
      )
        throw new Error("Saved replay identity mismatch");
      return page;
    },
    validateInitial: (initial) => replayDataEqual(initial, match.replay.initial),
    rules: getFourShogiDisplayReplayRules(match.replay.rulesVersion),
    finalGame: fourShogiPublicStateSchema.parse(match.game),
  });
}
