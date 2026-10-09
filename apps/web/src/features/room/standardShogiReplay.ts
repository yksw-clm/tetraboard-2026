import { sides } from "@tetraboard/shogi";
import {
  getShogiReplayContract,
  shogiPublicStateSchema,
  type ShogiLastRound,
} from "@tetraboard/protocol";
import { getShogiReplayRules, type ShogiReplayFrame } from "./standardShogiReplayV1";
import { fetchEventReplay } from "./fetchEventReplay";
export {
  createShogiReplayFrame,
  applyShogiReplayEvent,
  replayDataEqual,
  type ShogiReplayFrame,
} from "./standardShogiReplayV1";
export function fetchShogiReplay({
  roomId,
  instanceId,
  lastRound,
  signal,
}: {
  roomId: string;
  instanceId: string;
  lastRound: ShogiLastRound;
  signal: AbortSignal;
}): Promise<ShogiReplayFrame[]> {
  return fetchEventReplay({
    requestError: "Replay request failed",
    signal,
    path: (cursor) => {
      const query = new URLSearchParams({ instanceId });
      if (cursor > 0) query.set("cursor", String(cursor));
      return `/api${getShogiReplayContract.pathFor(roomId, lastRound.roundId)}?${query}`;
    },
    parsePage: (value) => {
      const page = getShogiReplayContract.response.parse(value);
      if (
        page.instanceId !== instanceId ||
        page.roundId !== lastRound.roundId ||
        page.eventCount !== lastRound.eventCount ||
        page.rulesVersion !== 1
      )
        throw new Error("Replay identity mismatch");
      return page;
    },
    validateInitial: (initial) =>
      sides.every(
        (side) => lastRound.players.find((p) => p.side === side)?.id === initial.players[side],
      ),
    rules: getShogiReplayRules(1),
    finalGame: shogiPublicStateSchema.parse(lastRound.game),
  });
}
