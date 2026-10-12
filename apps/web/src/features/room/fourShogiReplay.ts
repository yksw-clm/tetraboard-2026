import { sides } from "@tetraboard/four-shogi";
import {
  getFourShogiReplayContract,
  fourShogiPublicStateSchema,
  type FourShogiLastRound,
} from "@tetraboard/protocol";
import { getFourShogiDisplayReplayRules, type FourShogiReplayFrame } from "./fourShogiReplayV1";
import { fetchEventReplay } from "./fetchEventReplay";
export {
  createFourShogiReplayFrame,
  applyFourShogiReplayEvent,
  replayDataEqual,
  type FourShogiReplayFrame,
} from "./fourShogiReplayV1";
export function fetchFourShogiReplay({
  roomId,
  instanceId,
  lastRound,
  signal,
}: {
  roomId: string;
  instanceId: string;
  lastRound: FourShogiLastRound;
  signal: AbortSignal;
}): Promise<FourShogiReplayFrame[]> {
  return fetchEventReplay({
    requestError: "Replay request failed",
    signal,
    path: (cursor) => {
      const query = new URLSearchParams({ instanceId });
      if (cursor > 0) query.set("cursor", String(cursor));
      return `/api${getFourShogiReplayContract.pathFor(roomId, lastRound.roundId)}?${query}`;
    },
    parsePage: (value) => {
      const page = getFourShogiReplayContract.response.parse(value);
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
    rules: getFourShogiDisplayReplayRules(1),
    finalGame: fourShogiPublicStateSchema.parse(lastRound.game),
  });
}
