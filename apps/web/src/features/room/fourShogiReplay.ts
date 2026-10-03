import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  getCheckState,
  sides,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  getFourShogiReplayContract,
  fourShogiPublicStateSchema,
  type FourShogiLastRound,
  type FourShogiPublicState,
  type FourShogiReplayEvent,
  type FourShogiReplayPage,
} from "@tetraboard/protocol";
import { shogiEliminationLabels, shogiSideNames } from "./fourShogiRoomPresentation";

export type FourShogiReplayFrame = {
  label: string;
  game: FourShogiPublicState;
  checkState: ReturnType<typeof getCheckState>;
};

export function applyFourShogiReplayEvent(state: FourShogiState, event: FourShogiReplayEvent) {
  switch (event.type) {
    case "action":
      return applyAction(state, event.side, event.action);
    case "eliminate":
      return eliminateSide(state, event.side, event.reason);
    case "drawProposal":
      return setDrawProposal(state, event.side, event.proposed);
  }
}

export function createFourShogiReplayFrame(
  state: FourShogiState,
  event?: FourShogiReplayEvent,
): FourShogiReplayFrame {
  const { repetitions: _repetitions, ...game } = state;
  const label = event ? replayLabel(event, state) : "開始局面";
  return { label, game: fourShogiPublicStateSchema.parse(game), checkState: getCheckState(state) };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function replayDataEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function replayLabel(event: FourShogiReplayEvent, state: FourShogiState): string {
  if (event.type === "drawProposal")
    return `${shogiSideNames[event.side]} ${event.proposed ? "引分提案" : "引分取消"}`;
  if (event.type === "eliminate")
    return `${shogiSideNames[event.side]} ${shogiEliminationLabels[event.reason]}`;
  const action = event.action;
  const destination = `${String.fromCharCode(65 + action.to.x)}${action.to.y + 1}`;
  const suffix = action.type === "dropPiece" ? "打" : action.promote ? "成" : "";
  const kind = action.type === "dropPiece" ? action.pieceKind : state.lastMove?.piece.kind;
  const names = { pawn: "歩", silver: "銀", gold: "金", rook: "飛", king: "王" } as const;
  return `${state.moveNumber}: ${shogiSideNames[event.side]}${destination}${kind ? names[kind] : ""}${suffix}`;
}

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
      state = createInitialState(initial);
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
