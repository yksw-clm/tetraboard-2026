import { expect, test, mock } from "bun:test";
import {
  gameIds,
  isFourGomokuRoom,
  isFourReversiRoom,
  isFourShogiRoom,
  isShogiRoom,
  type Room,
} from "@tetraboard/protocol";
import { getActionAvailability } from "@tetraboard/four-shogi";
import { migrateRoomState } from "../src/adapters/room/roomStateVersion";
import { migrationDependencies, roomFixture } from "./roomStateFixtures";
import legacy from "../../../test-fixtures/matches/shogi-legacy.json";
import { eliminateSide } from "@tetraboard/shogi";

function migrate(saved: unknown, replay?: unknown): Room {
  const result = migrateRoomState(
    saved,
    0,
    migrationDependencies(() => replay),
  );
  if (!result.success) throw result.error;
  return result.data;
}
function expectMigration(saved: unknown, expected: Room, replay?: unknown) {
  const before = structuredClone(saved);
  const migrated = migrate(saved, replay);
  expect(migrated).toEqual(expected);
  expect(saved).toEqual(before);
  expect(migrate(migrated, replay)).toEqual(expected);
}
for (const game of gameIds)
  for (const status of ["waiting", "playing"] as const)
    test(`${game} ${status}: 今の状態は不変で、再移行も同じになる`, () => {
      const room = roomFixture(game, status);
      const read = mock(() => {
        throw Error("現在の状態では棋譜を読みません");
      });
      const result = migrateRoomState(room, 0, migrationDependencies(read));
      expect(result.success && result.data).toEqual(room);
      expect(read).not.toHaveBeenCalled();
      expectMigration(room, room);
    });

for (const game of ["four-shogi", "shogi"] as const)
  for (const status of ["playing", "waiting"] as const)
    test(`${game} ${status}: 進行局と直前局の引分提案を補う`, () => {
      const playing = roomFixture(game);
      if (playing.status !== "playing" || (!isFourShogiRoom(playing) && !isShogiRoom(playing)))
        throw Error();
      const finished = isShogiRoom(playing)
        ? eliminateSide({ ...playing.game, repetitions: {} }, "north", "left")
        : null;
      const { repetitions: _index, ...standard } = finished?.ok
        ? finished.state
        : { repetitions: {} };
      const current =
        status === "playing"
          ? playing
          : {
              ...roomFixture(game, "waiting"),
              lastRound: {
                roundId: playing.roundId,
                game: {
                  ...(game === "four-shogi" ? legacy.detail.game : standard),
                  drawProposals: [],
                },
                players: playing.players.map(({ id, name, side }) => ({ id, name, side })),
                eventCount: 0,
              },
            };
      const saved = structuredClone(current);
      const state = status === "playing" ? saved.game : saved.lastRound?.game;
      if (!state) throw Error();
      Reflect.deleteProperty(state, "drawProposals");
      expectMigration(saved, current as Room);
    });

for (const status of ["waiting", "playing"] as const)
  test(`reversi ${status}: 局IDと局面の版を補う`, () => {
    const room = roomFixture("reversi", status);
    const saved = structuredClone(room);
    Reflect.deleteProperty(saved, "roundId");
    Reflect.deleteProperty(saved, "positionRevision");
    expectMigration(saved, room, { id: "roundId" in room ? room.roundId : null });
  });

test("four-shogi: 三人攻めの禁止手を元の局面から補う", () => {
  const room = roomFixture("four-shogi");
  if (!isFourShogiRoom(room) || room.status !== "playing") throw Error();
  const pieces = [
    { side: "south", kind: "king", x: 0, y: 8 },
    { side: "west", kind: "king", x: 0, y: 0 },
    { side: "north", kind: "king", x: 8, y: 0 },
    { side: "east", kind: "king", x: 8, y: 8 },
    { side: "south", kind: "pawn", x: 3, y: 4 },
    { side: "west", kind: "gold", x: 3, y: 2 },
  ] as const;
  room.game.board = room.game.board.map((row) => row.map(() => null));
  pieces.forEach(({ x, y, side, kind }, id) => {
    room.game.board[y]![x] = { id, side, kind, promoted: false };
  });
  room.game.nextPieceId = pieces.length;
  room.game.threePlayerAttackProhibited = true;
  room.settings.threePlayerAttackProhibited = true;
  room.game.attackRelations = (["north", "east"] as const).map((attacker) => ({
    attacker,
    target: "west",
    reasons: ["check"],
    targetPieceIds: [],
    pendingSides: (["south", "west", "north", "east"] as const).filter((side) => side !== attacker),
  }));
  const expected = { ...room, ...getActionAvailability({ ...room.game, repetitions: {} }) };
  expect(expected.threePlayerAttackForbiddenActions).toEqual([
    { type: "movePiece", from: { x: 3, y: 4 }, to: { x: 3, y: 3 }, promote: false },
  ]);
  const saved = structuredClone(expected);
  Reflect.deleteProperty(saved, "threePlayerAttackForbiddenActions");
  expectMigration(saved, expected);
});

test("four-reversi: 棋譜にある脱落理由を重複せず補う", () => {
  const room = roomFixture("four-reversi");
  if (!isFourReversiRoom(room) || room.status !== "playing") throw Error();
  const initial = structuredClone(room.game);
  room.game.eliminatedColors.push("black");
  room.eliminations.push({ color: "black", reason: "resigned" });
  const saved = structuredClone(room);
  Reflect.deleteProperty(saved, "eliminations");
  const replay = {
    id: crypto.randomUUID(),
    initial,
    steps: [
      {
        action: { type: "eliminate", color: "black", reason: "resigned" },
        game: room.game,
        passedColors: [],
      },
    ],
  };
  expectMigration(saved, room, replay);
  expectMigration(saved, { ...room, eliminations: [] });
});

for (const status of ["waiting", "playing"] as const)
  test(`通常リバーシ ${status}: 脱落配列がない状態は移行でもschemaで拒否する`, () => {
    const saved = roomFixture("reversi", status);
    Reflect.deleteProperty(saved, "eliminations");
    const read = mock(() => {
      throw Error("schemaで失敗するため棋譜を読みません");
    });
    const deps = migrationDependencies(read);
    const migrateLegacy = mock(deps.migrateLegacy);
    const result = migrateRoomState(saved, 0, { ...deps, migrateLegacy });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("eliminations");
    expect(saved).not.toHaveProperty("eliminations");
    expect(read).not.toHaveBeenCalled();
    expect(migrateLegacy).not.toHaveBeenCalled();
  });

test("four-gomoku: 各色の最終手を棋譜から補う", () => {
  const room = roomFixture("four-gomoku");
  if (!isFourGomokuRoom(room) || room.status !== "playing") throw Error();
  room.game.lastMoves = {
    black: { x: 4, y: 0 },
    white: { x: 1, y: 0 },
    red: { x: 2, y: 0 },
    blue: { x: 3, y: 0 },
  };
  const saved = structuredClone(room);
  Reflect.deleteProperty(saved.game, "lastMoves");
  const steps = ["black", "white", "red", "blue", "black"].map((color, x) => ({
    action: { type: "place", color, position: { x, y: 0 } },
  }));
  expectMigration(saved, room, { id: room.roundId, steps });
  expect(migrate(saved, { id: crypto.randomUUID(), steps })).toEqual(saved);
});

test("壊れた状態のschema失敗は移行の結果として返す", () => {
  const deps = migrationDependencies(() => undefined);
  expect(migrateRoomState(null, 0, deps).success).toBe(false);
  expect(
    migrateRoomState({ settings: { game: "shogi" }, game: { drawProposals: null } }, 0, deps)
      .success,
  ).toBe(false);
});

test("通常リバーシのnullの脱落配列は補わず拒否する", () => {
  const room = roomFixture("reversi");
  const saved = { ...room, eliminations: null };
  expect(
    migrateRoomState(
      saved,
      0,
      migrationDependencies(() => undefined),
    ).success,
  ).toBe(false);
});
