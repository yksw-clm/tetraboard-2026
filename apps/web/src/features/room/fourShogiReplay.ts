import { sides, type FourShogiState } from "@tetraboard/four-shogi";
import {
  getFourShogiReplayContract,
  fourShogiPublicStateSchema,
  type FourShogiLastRound,
  type FourShogiReplayPage,
} from "@tetraboard/protocol";
import {
  getFourShogiReplayRules,
  createFourShogiReplayFrame,
  applyFourShogiReplayEvent,
  replayDataEqual,
  type FourShogiReplayFrame,
} from "./fourShogiReplayV1";
export {
  createFourShogiReplayFrame,
  applyFourShogiReplayEvent,
  replayDataEqual,
  type FourShogiReplayFrame,
} from "./fourShogiReplayV1";
export async function fetchFourShogiReplay({
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
  let cursor = 0;
  let initial: FourShogiReplayPage["initial"] | null = null;
  let state: FourShogiState | null = null;
  const frames: FourShogiReplayFrame[] = [];
  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const query = new URLSearchParams({ instanceId });
    if (cursor > 0) query.set("cursor", String(cursor));
    const response = await fetch(
      `/api${getFourShogiReplayContract.pathFor(roomId, lastRound.roundId)}?${query}`,
      { cache: "no-store", signal },
    );
    if (!response.ok) throw new Error("Replay request failed");
    const page = getFourShogiReplayContract.response.parse(await response.json());
    if (
      page.instanceId !== instanceId ||
      page.roundId !== lastRound.roundId ||
      page.eventCount !== lastRound.eventCount ||
      page.rulesVersion !== 1
    )
      throw new Error("Replay identity mismatch");
    if (initial === null) {
      initial = page.initial;
      if (
        sides.some(
          (side) =>
            lastRound.players.find((player) => player.side === side)?.id !== initial!.players[side],
        )
      )
        throw new Error("Replay players mismatch");
      state = getFourShogiReplayRules(page.rulesVersion).initialize(initial);
      frames.push(createFourShogiReplayFrame(state));
    } else if (!replayDataEqual(initial, page.initial))
      throw new Error("Replay initial options changed");
    const next = cursor + page.events.length;
    if (
      next > page.eventCount ||
      (page.nextCursor === null
        ? next !== page.eventCount
        : page.events.length === 0 || page.nextCursor !== next || next >= page.eventCount)
    )
      throw new Error("Replay pagination mismatch");
    for (const entry of page.events) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (entry.index !== cursor || state === null) throw new Error("Replay event index mismatch");
      const event = entry.event;
      const result = applyFourShogiReplayEvent(state, event);
      if (!result.ok) throw new Error("Replay event is invalid");
      state = result.state;
      frames.push(createFourShogiReplayFrame(state, event));
      cursor++;
    }
    if (page.nextCursor === null) break;
  }
  const final = frames.at(-1)?.game;
  if (
    !final ||
    final.status !== "finished" ||
    !replayDataEqual(final, fourShogiPublicStateSchema.parse(lastRound.game))
  )
    throw new Error("Replay final position mismatch");
  return frames;
}
