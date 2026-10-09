import {
  getMatchReplayContract,
  getPublicMatchReplayContract,
  shogiPublicStateSchema,
  shogiMatchReplayPageSchema,
  type ReplayShogiMatch,
} from "@tetraboard/protocol";
import { getShogiReplayRules, type ShogiReplayFrame } from "./standardShogiReplayV1";
import { replayDataEqual } from "./replayDataEqual";
import { fetchEventReplay } from "./fetchEventReplay";
export function fetchShogiMatchReplay(
  match: ReplayShogiMatch,
  signal: AbortSignal,
): Promise<ShogiReplayFrame[]> {
  const contract = match.selfPlayerId ? getMatchReplayContract : getPublicMatchReplayContract;
  return fetchEventReplay({
    signal,
    path: (cursor) => `/api${contract.pathFor(match.id)}${cursor ? `?cursor=${cursor}` : ""}`,
    parsePage: (value) => {
      const page = shogiMatchReplayPageSchema.parse(value);
      if (
        page.matchId !== match.id ||
        page.rulesVersion !== match.replay.rulesVersion ||
        page.eventCount !== match.replay.eventCount
      )
        throw new Error("Saved replay identity mismatch");
      return page;
    },
    validateInitial: (initial) => replayDataEqual(initial, match.replay.initial),
    rules: getShogiReplayRules(match.replay.rulesVersion),
    finalGame: shogiPublicStateSchema.parse(match.game),
  });
}
