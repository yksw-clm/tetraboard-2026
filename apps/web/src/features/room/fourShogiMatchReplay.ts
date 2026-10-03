import { applyAction, createInitialState, eliminateSide } from "@tetraboard/four-shogi";
import { getMatchReplayContract, type FourShogiMatchDetail } from "@tetraboard/protocol";
import {
  createFourShogiReplayFrame,
  replayDataEqual,
  type FourShogiReplayFrame,
} from "./fourShogiReplay";

export async function fetchFourShogiMatchReplay(
  match: FourShogiMatchDetail,
  signal: AbortSignal,
): Promise<FourShogiReplayFrame[]> {
  let cursor = 0;
  let state = createInitialState(match.replay.initial);
  const frames = [createFourShogiReplayFrame(state)];
  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const query = cursor === 0 ? "" : `?cursor=${cursor}`;
    const response = await fetch(`/api${getMatchReplayContract.pathFor(match.id)}${query}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Response(null, { status: response.status });
    const page = getMatchReplayContract.response.parse(await response.json());
    if (
      page.matchId !== match.id ||
      page.rulesVersion !== match.replay.rulesVersion ||
      page.eventCount !== match.replay.eventCount ||
      !replayDataEqual(page.initial, match.replay.initial)
    )
      throw new Error("Saved replay identity mismatch");
    const next = cursor + page.events.length;
    if (
      next > page.eventCount ||
      (page.nextCursor === null
        ? next !== page.eventCount
        : page.events.length === 0 || page.nextCursor !== next || next >= page.eventCount)
    )
      throw new Error("Saved replay pagination mismatch");
    for (const entry of page.events) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (entry.index !== cursor) throw new Error("Saved replay event index mismatch");
      const event = entry.event;
      const result =
        event.type === "action"
          ? applyAction(state, event.side, event.action)
          : eliminateSide(state, event.side, event.reason);
      if (!result.ok) throw new Error("Saved replay event is invalid");
      state = result.state;
      frames.push(createFourShogiReplayFrame(state, event));
      cursor++;
    }
    if (page.nextCursor === null) break;
  }
  const final = frames.at(-1)?.game;
  if (!final || final.status !== "finished" || !replayDataEqual(final, match.game))
    throw new Error("Saved replay final position mismatch");
  return frames;
}
