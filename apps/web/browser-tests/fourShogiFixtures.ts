import {
  applyAction,
  createInitialState,
  eliminateSide,
  getCheckState,
  getActionAvailability,
  sides,
  type FourShogiState,
  type Piece,
  type Side,
} from "@tetraboard/four-shogi";
import {
  fourShogiRoomSchema,
  fourShogiPublicStateSchema,
  type FourShogiPublicState,
  type FourShogiRoom,
} from "@tetraboard/protocol";
import { now, playerIds, waitingRoom } from "./fixtures";

export const shogiRoundId = "00000000-0000-4000-8000-000000000020";
export function publicShogiState(state: FourShogiState): FourShogiPublicState {
  const { repetitions: _repetitions, ...view } = structuredClone(state);
  return fourShogiPublicStateSchema.parse(view);
}
export function initialShogiState() {
  const state = createInitialState({
    mode: "singles",
    players: {
      south: playerIds[0]!,
      west: playerIds[1]!,
      north: playerIds[2]!,
      east: playerIds[3]!,
    },
  });
  if (state.status !== "playing") throw new Error("Expected initial playing state");
  return state;
}
export function waitingShogiRoom(): FourShogiRoom & { status: "waiting" } {
  const room = waitingRoom();
  const parsed = fourShogiRoomSchema.parse({
    ...room,
    settings: { ...room.settings, game: "four-shogi", threePlayerAttackProhibited: true },
    players: room.players.map(({ color: _color, ...p }) => ({ ...p, side: null })),
    checkState: { south: false, west: false, north: false, east: false },
    roundId: null,
    positionRevision: 0,
    legalActions: [],
    threePlayerAttackForbiddenActions: [],
  });
  if (parsed.status !== "waiting") throw new Error("Expected waiting shogi fixture");
  return parsed;
}
export function playingShogiRoom(
  state: FourShogiState = initialShogiState(),
  positionRevision = 0,
): FourShogiRoom & { status: "playing" } {
  if (state.status !== "playing") throw new Error("Expected playing shogi state");
  const room = waitingShogiRoom();
  const parsed = fourShogiRoomSchema.parse({
    ...room,
    settings: {
      ...room.settings,
      mode: state.mode,
      threePlayerAttackProhibited: state.threePlayerAttackProhibited,
    },
    status: "playing",
    players: room.players.map((p, i) => ({ ...p, ready: true, side: sides[i] })),
    game: publicShogiState(state),
    roundId: shogiRoundId,
    positionRevision,
    checkState: getCheckState(state),
    ...getActionAvailability(state),
    clock: {
      remainingMainMs: { south: 300000, west: 300000, north: 300000, east: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
  if (parsed.status !== "playing") throw new Error("Expected playing shogi fixture");
  return parsed;
}
// UIの固定局面。合法手と遷移は公開エンジンで作り、hookや盤面は差し替えません。
export function tacticalShogiState(turn: Side = "south"): FourShogiState {
  const board: (Piece | null)[][] = Array.from({ length: 9 }, () => Array(9).fill(null));
  let id = 1;
  const place = (x: number, y: number, side: Side, kind: Piece["kind"]) => {
    board[y]![x] = { id: id++, side, kind, promoted: false };
  };
  place(4, 8, "south", "king");
  place(0, 4, "west", "king");
  place(4, 0, "north", "king");
  place(8, 4, "east", "king");
  place(4, 6, "south", "pawn");
  place(3, 3, "south", "silver");
  place(5, 7, "south", "gold");
  place(2, 6, "south", "rook");
  place(4, 5, "north", "silver");
  place(2, 4, "west", "pawn");
  place(4, 2, "north", "pawn");
  place(6, 4, "east", "pawn");
  const initial = initialShogiState();
  return {
    ...initial,
    board,
    nextPieceId: id,
    turn,
    repetitions: {},
    hands: Object.fromEntries(
      sides.map((side) => [side, { pawn: 3, silver: 1, gold: 1, rook: 1 }]),
    ) as FourShogiState["hands"],
  };
}
export function finishedShogiRound() {
  let state: FourShogiState = initialShogiState();
  const action = getActionAvailability(state).legalActions[0]!;
  const moved = applyAction(state, state.status === "playing" ? state.turn : "south", action);
  if (!moved.ok) throw new Error("Invalid initial fixture action");
  state = moved.state;
  const events = [{ index: 0, event: { type: "action" as const, side: "south" as const, action } }];
  const allEvents: (
    | { index: number; event: { type: "action"; side: Side; action: typeof action } }
    | { index: number; event: { type: "eliminate"; side: Side; reason: "left" } }
  )[] = [...events];
  for (const side of ["west", "north", "east"] as const) {
    const next = eliminateSide(state, side, "left");
    if (!next.ok) throw new Error("Invalid fixture elimination");
    state = next.state;
    allEvents.push({ index: allEvents.length, event: { type: "eliminate", side, reason: "left" } });
  }
  if (state.status !== "finished") throw new Error("Expected finished fixture");
  const room = waitingShogiRoom();
  room.lastRound = {
    roundId: shogiRoundId,
    game: publicShogiState(state) as NonNullable<FourShogiRoom["lastRound"]>["game"],
    players: sides.map((side, i) => ({ id: playerIds[i]!, name: room.players[i]!.name, side })),
    eventCount: allEvents.length,
  };
  return { room, events: allEvents };
}
