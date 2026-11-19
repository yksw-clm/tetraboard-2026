import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { getLegalActions, getActionAvailability, type Side } from "@tetraboard/four-shogi";
import { roomSocketContract, fourShogiRoomSchema } from "@tetraboard/protocol";
import { ShogiStore } from "../src/adapters/room/games/four-shogi/store";
import {
  readShogiMatchRecord,
  shogiMatchStartKey,
  type ActiveShogiMatch,
} from "../src/adapters/record/shogiMatchStore";
import {
  registerFourShogiRoomFixtures,
  start,
  sideIndex,
  get,
  connect,
  resignCurrent,
} from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

test("サーバー合法手を受理し、古い局面・対局・手番違い・不正手は状態を変えず拒否する", async () => {
  const prepared = await start();
  const before = prepared.room;
  const index = sideIndex(prepared, "south");
  const actor = prepared.clients[index];
  const action = before.legalActions[0];
  actor.send({ type: "room.game.action", roundId: before.roundId, positionRevision: 1, action });
  expect(await actor.error()).toBe("stale_position");
  actor.send({
    type: "room.game.action",
    roundId: crypto.randomUUID(),
    positionRevision: 0,
    action,
  });
  expect(await actor.error()).toBe("stale_position");
  prepared.clients[sideIndex(prepared, "west")].send({
    type: "room.game.action",
    roundId: before.roundId,
    positionRevision: 0,
    action,
  });
  expect(await prepared.clients[sideIndex(prepared, "west")].error()).toBe("not_your_turn");
  actor.send({
    type: "room.game.action",
    roundId: before.roundId,
    positionRevision: 0,
    action: { type: "dropPiece", pieceKind: "rook", to: { x: 4, y: 4 } },
  });
  expect(await actor.error()).toBe("invalid_move");
  expect(await get(prepared.id)).toEqual(before);
  actor.send({ type: "room.game.action", roundId: before.roundId, positionRevision: 0, action });
  const moved = await actor.room(
    (room) => room.status === "playing" && room.positionRevision === 1,
  );
  if (moved.status !== "playing") throw new Error("Not playing");
  expect(moved.game.moveNumber).toBe(1);
  expect(moved.game.lastMove).toMatchObject({ side: "south", action });
  expect(moved.game.turn).toBe("west");
  expect(moved.clock.remainingMainMs.south).toBeLessThanOrEqual(before.clock.remainingMainMs.south);
  expect(moved.clock.turnExpiresAt - moved.clock.turnStartedAt).toBe(330000);
  actor.send({ type: "room.game.action", roundId: before.roundId, positionRevision: 0, action });
  expect(await actor.error()).toBe("stale_position");
  expect((await get(prepared.id)).game).toEqual(moved.game);
});

test("将棋着手には局IDとrevisionを必須とし、リバーシ着手形式は維持する", () => {
  expect(
    roomSocketContract.clientMessage.safeParse({
      type: "room.game.action",
      action: { type: "movePiece", from: { x: 4, y: 8 }, to: { x: 4, y: 7 }, promote: false },
    }).success,
  ).toBe(false);
  expect(
    roomSocketContract.clientMessage.safeParse({
      type: "room.game.action",
      action: { type: "placeStone", position: { x: 4, y: 2 } },
    }).success,
  ).toBe(false);
  expect(
    roomSocketContract.clientMessage.safeParse({
      type: "room.game.action",
      action: { type: "dropPiece", pieceKind: "pawn", to: { x: 1, y: 1 } },
      roundId: crypto.randomUUID(),
      positionRevision: 0,
    }).success,
  ).toBe(true);
});

test("固定局面で成り・捕獲・持ち駒・王手優先をサーバーの遷移と合法手へ反映する", async () => {
  const prepared = await start();
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const store = new ShogiStore(state.storage.sql);
    const game = store.loadState(room.roundId, room.game);
    if (game.status !== "playing") throw new Error("Not playing");
    const board = Array.from({ length: 9 }, () =>
      Array<import("@tetraboard/four-shogi").Piece | null>(9).fill(null),
    );
    board[8][4] = { id: 0, side: "south", kind: "king", promoted: false };
    board[4][0] = { id: 1, side: "west", kind: "king", promoted: false };
    board[0][4] = { id: 2, side: "north", kind: "king", promoted: false };
    board[4][8] = { id: 3, side: "east", kind: "king", promoted: false };
    board[3][4] = { id: 4, side: "south", kind: "rook", promoted: false };
    board[2][4] = { id: 5, side: "north", kind: "silver", promoted: false };
    const fixture = {
      ...game,
      board,
      nextPieceId: 6,
      threePlayerAttackProhibited: false,
      repetitions: {},
    };
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        settings: { ...room.settings, threePlayerAttackProhibited: false },
        game: store.saveState(room.roundId, fixture),
        ...getActionAvailability(fixture),
      }),
    );
  });
  const actor = prepared.clients[sideIndex(prepared, "south")];
  const fixture = await get(prepared.id);
  if (fixture.status !== "playing") throw new Error("Not playing");
  const action = {
    type: "movePiece" as const,
    from: { x: 4, y: 3 },
    to: { x: 4, y: 2 },
    promote: true,
  };
  expect(fixture.legalActions).toContainEqual(action);
  actor.send({ type: "room.game.action", roundId: fixture.roundId, positionRevision: 0, action });
  const moved = await actor.room(
    (room) => room.status === "playing" && room.positionRevision === 1,
  );
  if (moved.status !== "playing") throw new Error("Not playing");
  expect(moved.game.board[2][4]).toMatchObject({
    id: 4,
    side: "south",
    kind: "rook",
    promoted: true,
  });
  expect(moved.game.hands.south.silver).toBe(1);
  expect(moved.game.lastMove?.captured).toMatchObject({ id: 5, side: "north", kind: "silver" });
  expect(moved.game.turn).toBe("north");
  expect(moved.checkState.north).toBe(true);
  expect(moved.game.eliminations).toEqual([]);
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const store = new ShogiStore(state.storage.sql);
    const game = {
      ...store.loadState(room.roundId, room.game),
      status: "playing" as const,
      result: null,
      turn: "south" as const,
    };
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        game: store.saveState(room.roundId, game),
        legalActions: getLegalActions(game),
      }),
    );
  });
  const ready = await get(prepared.id);
  if (ready.status !== "playing") throw new Error("Not playing");
  const drop = { type: "dropPiece" as const, pieceKind: "silver" as const, to: { x: 3, y: 5 } };
  expect(ready.legalActions).toContainEqual(drop);
  actor.send({
    type: "room.game.action",
    roundId: ready.roundId,
    positionRevision: ready.positionRevision,
    action: drop,
  });
  const dropped = await actor.room(
    (room) => room.status === "playing" && room.positionRevision === 2,
  );
  expect(dropped.game?.hands.south.silver).toBe(0);
  expect(dropped.game?.board[5][3]).toMatchObject({
    id: 6,
    side: "south",
    kind: "silver",
    promoted: false,
  });
});

async function seedPosition(
  prepared: Awaited<ReturnType<typeof start>>,
  pieces: { side: Side; kind: import("@tetraboard/four-shogi").PieceKind; x: number; y: number }[],
  prohibited: boolean,
  attackRelations: import("@tetraboard/four-shogi").AttackRelation[] = [],
) {
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const store = new ShogiStore(state.storage.sql);
    const game = store.loadState(room.roundId, room.game);
    if (game.status !== "playing") throw new Error("Not playing");
    const board = Array.from({ length: 9 }, () =>
      Array<import("@tetraboard/four-shogi").Piece | null>(9).fill(null),
    );
    pieces.forEach((piece, id) => {
      board[piece.y][piece.x] = { id, side: piece.side, kind: piece.kind, promoted: false };
    });
    const fixture = {
      ...game,
      board,
      turn: "south" as const,
      nextPieceId: pieces.length,
      threePlayerAttackProhibited: prohibited,
      attackRelations,
    };
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        settings: { ...room.settings, threePlayerAttackProhibited: prohibited },
        game: store.saveState(room.roundId, fixture),
        ...getActionAvailability(fixture),
      }),
    );
  });
}

test.each([true, false])(
  "三人攻撃禁止%sを攻撃履歴つき固定局面の合法手・受理へ適用する",
  async (prohibited) => {
    const prepared = await start();
    const kings = [
      { side: "south" as const, kind: "king" as const, x: 0, y: 8 },
      { side: "west" as const, kind: "king" as const, x: 0, y: 0 },
      { side: "north" as const, kind: "king" as const, x: 8, y: 0 },
      { side: "east" as const, kind: "king" as const, x: 8, y: 8 },
    ];
    await seedPosition(
      prepared,
      [
        ...kings,
        { side: "south", kind: "pawn", x: 3, y: 4 },
        { side: "west", kind: "gold", x: 3, y: 2 },
      ],
      prohibited,
      [
        {
          attacker: "north",
          target: "west",
          reasons: ["check"],
          targetPieceIds: [],
          pendingSides: ["south", "west", "east"],
        },
        {
          attacker: "east",
          target: "west",
          reasons: ["check"],
          targetPieceIds: [],
          pendingSides: ["south", "west", "north"],
        },
      ],
    );
    const before = await get(prepared.id);
    if (before.status !== "playing") throw new Error("Not playing");
    const action = {
      type: "movePiece" as const,
      from: { x: 3, y: 4 },
      to: { x: 3, y: 3 },
      promote: false,
    };
    expect(
      before.legalActions.some((entry) => JSON.stringify(entry) === JSON.stringify(action)),
    ).toBe(!prohibited);
    expect(before.threePlayerAttackForbiddenActions).toEqual(prohibited ? [action] : []);
    // 旧保存局面でも、同じrevisionの禁止候補をGETと再接続へ補完します。
    await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
      const saved = state.storage.kv.get<Record<string, unknown>>("room")!;
      delete saved.threePlayerAttackForbiddenActions;
      state.storage.kv.delete("room-state-version");
      state.storage.kv.put("room", saved);
    });
    expect(await get(prepared.id)).toEqual(before);
    const observer = await connect(prepared.id);
    expect(await observer.room((room) => room.status === "playing")).toEqual(before);
    const actor = prepared.clients[sideIndex(prepared, "south")];
    actor.send({
      type: "room.game.action",
      roundId: before.roundId,
      positionRevision: before.positionRevision,
      action,
    });
    if (prohibited) {
      expect(await actor.error()).toBe("invalid_move");
      expect(await get(prepared.id)).toEqual(before);
    } else {
      const accepted = await actor.room(
        (room) => room.status === "playing" && room.positionRevision === 1,
      );
      expect(accepted.game?.lastMove?.action).toEqual(action);
    }
  },
);

test("南が東を撃破したら西へ時計と手番を移し、自動詰みを棋譜へ重複記録しない", async () => {
  const prepared = await start();
  await seedPosition(
    prepared,
    [
      { side: "south", kind: "king", x: 0, y: 8 },
      { side: "west", kind: "king", x: 0, y: 0 },
      { side: "north", kind: "king", x: 4, y: 0 },
      { side: "east", kind: "king", x: 8, y: 8 },
      { side: "south", kind: "rook", x: 8, y: 4 },
      { side: "south", kind: "gold", x: 8, y: 6 },
      { side: "south", kind: "gold", x: 7, y: 7 },
    ],
    false,
  );
  const room = await get(prepared.id);
  if (room.status !== "playing") throw new Error("Not playing");
  const actor = prepared.clients[sideIndex(prepared, "south")];
  const action = {
    type: "movePiece" as const,
    from: { x: 8, y: 6 },
    to: { x: 7, y: 6 },
    promote: false,
  };
  actor.send({ type: "room.game.action", roundId: room.roundId, positionRevision: 0, action });
  const moved = await actor.room(
    (room) => room.status === "playing" && room.positionRevision === 1,
  );
  if (moved.status !== "playing") throw new Error("Not playing");
  expect(moved.game.turn).toBe("west");
  expect(moved.game.eliminations).toEqual([
    { side: "east", reason: "checkmate", rank: 4, group: 1 },
  ]);
  expect(moved.eliminations).toEqual(moved.game.eliminations);
  expect(moved.clock.turnExpiresAt - moved.clock.turnStartedAt).toBe(330000);
  expect(moved.game.board[8][8]).toMatchObject({ side: "east", kind: "king" });
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const stored = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (stored.status !== "playing") throw new Error("Not playing");
    const page = new ShogiStore(state.storage.sql).getPage(stored.instanceId, stored.roundId, 0)!;
    expect(page.eventCount).toBe(1);
    expect(page.events[0].event).toEqual({ type: "action", side: "south", action });
  });
});

test.each([
  { mode: "singles" as const, simultaneous: false, stalled: false, cpu: true, count: 1 },
  { mode: "singles" as const, simultaneous: true, stalled: false, cpu: false, count: 2 },
  { mode: "singles" as const, simultaneous: false, stalled: true, cpu: false, count: 0 },
  { mode: "doubles" as const, simultaneous: true, stalled: false, cpu: false, count: 0 },
])("受理した着手だけに撃破数を帰属する %j", async ({ mode, simultaneous, stalled, cpu, count }) => {
  const prepared = await start(mode);
  const pieces: Parameters<typeof seedPosition>[1] = [
    { side: "south", kind: "king", x: simultaneous ? 4 : 0, y: 8 },
    { side: "west", kind: "king", x: 0, y: 0 },
    {
      side: "north",
      kind: "king",
      x: simultaneous && mode === "doubles" ? 8 : stalled || simultaneous ? 8 : 4,
      y: mode === "doubles" ? 8 : 0,
    },
    { side: "east", kind: "king", x: 8, y: mode === "doubles" ? 0 : 8 },
  ];
  if (simultaneous)
    pieces.push(
      { side: "south", kind: "rook", x: 4, y: 1 },
      { side: "south", kind: "gold", x: 1, y: 2 },
      { side: "south", kind: "gold", x: 7, y: 2 },
    );
  else if (stalled)
    pieces.push(
      { side: "south", kind: "gold", x: 1, y: 2 },
      { side: "south", kind: "gold", x: 2, y: 1 },
      { side: "south", kind: "pawn", x: 5, y: 5 },
    );
  else
    pieces.push(
      { side: "south", kind: "rook", x: 8, y: 4 },
      { side: "south", kind: "gold", x: 8, y: 6 },
      { side: "south", kind: "gold", x: 7, y: 7 },
    );
  await seedPosition(prepared, pieces, true);
  const stub = env.GAME_ROOM.getByName(prepared.id);
  if (cpu)
    await runInDurableObject(stub, (_instance, state) => {
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      // CPU席の保存境界を作る際は、元の人間席の接続権限も解除します。
      const player = room.players.find((entry) => entry.side === "east")!;
      const tokenHash = state.storage.kv.get<string>(`player-token:${player.id}`)!;
      state.storage.kv.delete(`membership:${tokenHash}`);
      state.storage.kv.delete(`player-token:${player.id}`);
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          players: room.players.map((player) =>
            player.side === "east"
              ? {
                  id: player.id,
                  name: player.name,
                  side: player.side,
                  reconnectDeadline: null,
                  kind: "cpu",
                  level: 1,
                  ready: true,
                }
              : player,
          ),
        }),
      );
      const active = state.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey)!;
      delete active.formationUsage;
      active.start.participants = active.start.participants.map((player) =>
        player.side === "east"
          ? {
              id: player.id,
              name: player.name,
              side: player.side,
              seat: player.seat,
              kind: "cpu",
              level: 1,
            }
          : player,
      );
      state.storage.kv.put(shogiMatchStartKey, active);
    });
  const before = await get(prepared.id);
  if (before.status !== "playing") throw new Error("Not playing");
  const action = {
    type: "movePiece" as const,
    from: simultaneous ? { x: 4, y: 1 } : stalled ? { x: 5, y: 5 } : { x: 8, y: 6 },
    to: simultaneous ? { x: 4, y: 0 } : stalled ? { x: 5, y: 4 } : { x: 7, y: 6 },
    promote: false,
  };
  const actor = prepared.clients[sideIndex(prepared, "south")];
  actor.send({ type: "room.game.action", roundId: before.roundId, positionRevision: 1, action });
  expect(await actor.error()).toBe("stale_position");
  actor.send({ type: "room.game.action", roundId: before.roundId, positionRevision: 0, action });
  let room = await actor.room((next) => next.status === "waiting" || next.positionRevision === 1);
  const eliminations =
    room.status === "waiting" ? room.lastRound!.game.eliminations : room.game.eliminations;
  expect(eliminations).toHaveLength(simultaneous ? 2 : 1);
  expect(
    eliminations.every((entry) => entry.reason === (stalled ? "no_legal_actions" : "checkmate")),
  ).toBe(true);
  if (room.status === "playing") {
    actor.send({ type: "room.game.action", roundId: before.roundId, positionRevision: 0, action });
    expect(await actor.error()).toBe("stale_position");
  }
  while (room.status === "playing") room = await resignCurrent(prepared, room);
  const matchId = room.lastRound!.roundId;
  if (cpu)
    expect(room.lastRound!.players.find((player) => player.side === "east")?.appearance).toEqual({
      kind: "cpu",
      level: 1,
    });
  await vi.waitFor(async () => {
    const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(matchId)
      .first<{ record_json: string }>();
    expect(row).not.toBeNull();
    const saved = readShogiMatchRecord(row!.record_json);
    expect(saved.knockouts).toEqual({ south: count, west: 0, north: 0, east: 0 });
    if (cpu)
      expect(saved.participants.find((player) => player.side === "east")).toMatchObject({
        kind: "cpu",
        level: 1,
      });
  });
});
