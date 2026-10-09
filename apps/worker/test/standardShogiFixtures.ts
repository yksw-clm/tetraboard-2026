import { env } from "cloudflare:workers";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  getLegalActions,
  type ShogiState,
  type ShogiAction,
} from "@tetraboard/shogi";
import { finishedShogiStateSchema, type ShogiReplayEvent } from "@tetraboard/protocol";
import {
  advanceShogiMatchSave,
  type StandardShogiMatchRecord,
  type ShogiSaveProgress,
} from "../src/rooms/shogiMatchStore";

export const goldCycle: ShogiAction[] = [
  { type: "movePiece", from: { x: 3, y: 8 }, to: { x: 3, y: 7 }, promote: false },
  { type: "movePiece", from: { x: 3, y: 0 }, to: { x: 3, y: 1 }, promote: false },
  { type: "movePiece", from: { x: 3, y: 7 }, to: { x: 3, y: 8 }, promote: false },
  { type: "movePiece", from: { x: 3, y: 1 }, to: { x: 3, y: 0 }, promote: false },
];

export function standardShogiRecord(
  accountId: string | null,
  outcome: "win" | "loss" | "draw" = "win",
  cpu = false,
  plies = 0,
) {
  const players = { south: crypto.randomUUID(), north: crypto.randomUUID() };
  const initial = { players };
  let game = createInitialState(initial);
  const events: ShogiReplayEvent[] = [];
  let seed = 123;
  for (let index = 0; index < (outcome === "draw" ? 12 : plies); index++) {
    if (game.status !== "playing") throw Error("Fixture finished early");
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const legal = getLegalActions(game);
    const action = outcome === "draw" ? goldCycle[index % 4] : legal[seed % legal.length];
    const next = applyAction(game, game.turn, action);
    if (!next.ok) throw Error(next.reason);
    events.push({ type: "action", side: game.turn, action });
    game = next.state;
  }
  if (outcome !== "draw") {
    const side = outcome === "win" ? "north" : "south";
    const ended = eliminateSide(game, side, "left");
    if (!ended.ok) throw Error(ended.reason);
    game = ended.state;
    events.push({ type: "eliminate", side, reason: "left" });
  }
  const { repetitions: _index, ...core } = game;
  const record: StandardShogiMatchRecord = {
    id: crypto.randomUUID(),
    roomId: "12345",
    instanceId: crypto.randomUUID(),
    startedAtMs: 1700000000000,
    endedAtMs: 1700000001000,
    settings: { game: "shogi", timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 } },
    participants: (["south", "north"] as const).map((side, seat) => ({
      id: players[side],
      side,
      seat,
      name: side,
      ...(cpu && side === "north"
        ? { kind: "cpu" as const, level: 2 as const }
        : { kind: "human" as const, accountId: side === "south" ? accountId : null }),
    })),
    game: finishedShogiStateSchema.parse(core),
    replay: { rulesVersion: 1, initial, eventCount: events.length },
  };
  return { record, events };
}
export async function saveStandardShogiFixture(fixture: ReturnType<typeof standardShogiRecord>) {
  let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
  while (progress)
    progress = await advanceShogiMatchSave(env.APP_DB, fixture.record, progress, (cursor) =>
      fixture.events.slice(cursor, cursor + 100),
    );
}

export function enteringState(players: ShogiState["players"], points = 31): ShogiState {
  const initial = createInitialState({ players });
  const board = initial.board.map((row) =>
    row.map(() => null),
  ) as ShogiState["board"][number][number][][];
  board[1][4] = { id: 1, kind: "king", side: "south", promoted: false };
  board[8][8] = { id: 2, kind: "king", side: "north", promoted: false };
  for (let i = 0; i < 10; i++)
    board[Math.floor(i / 9)][i % 9] = { id: i + 3, kind: "gold", side: "south", promoted: false };
  return {
    ...initial,
    board,
    nextPieceId: 100,
    repetitions: {},
    hands: {
      south: { ...initial.hands.south, pawn: points - 10 },
      north: { ...initial.hands.north, pawn: 24 },
    },
  };
}
