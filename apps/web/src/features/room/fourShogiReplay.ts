import {
  applyAction,
  createInitialState,
  eliminateSide,
  getCheckState,
  sides,
  type Elimination,
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

export function createFourShogiReplayFrame(
  state: FourShogiState,
  event?: FourShogiReplayEvent,
  eliminations: readonly Elimination[] = [],
): FourShogiReplayFrame {
  const { repetitions: _repetitions, ...game } = state;
  const groups = new Map<number, Elimination[]>();
  for (const entry of eliminations) {
    const group = groups.get(entry.group) ?? [];
    group.push(entry);
    groups.set(entry.group, group);
  }
  // 一つの着手で自動確定した脱落も、同時処理群を保って同じ棋譜項目に表示します。
  const departures = [...groups.values()].map(
    (group) =>
      `${group.length > 1 ? "同時脱落" : "脱落"}：${group
        .map(
          (entry) =>
            `${shogiSideNames[entry.side]}${entry.rank === null ? "" : `${entry.rank}位`}（${shogiEliminationLabels[entry.reason]}）`,
        )
        .join("・")}`,
  );
  const label = [event ? replayLabel(event, state) : "開始局面", ...departures].join(" / ");
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

function replayLabel(event: FourShogiReplayEvent, state: FourShogiState): string {
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
    } else if (stableJson(initial) !== stableJson(page.initial))
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
      const result =
        event.type === "action"
          ? applyAction(state, event.side, event.action)
          : eliminateSide(state, event.side, event.reason);
      if (!result.ok) throw new Error("Replay event is invalid");
      state = result.state;
      frames.push(createFourShogiReplayFrame(state, event, result.eliminations));
      cursor++;
    }
    if (page.nextCursor === null) break;
  }
  const final = frames.at(-1)?.game;
  if (!final || final.status !== "finished" || stableJson(final) !== stableJson(lastRound.game))
    throw new Error("Replay final position mismatch");
  return frames;
}
