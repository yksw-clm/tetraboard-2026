import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import {
  avatarPresets,
  avatarPresetUrl,
  fourReversiRoomSchema,
  isFourReversiRoom,
  roundReplaySchema,
  roomSocketContract,
  type FourReversiRoom,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { readRoomDeletionAccounts } from "../src/adapters/privacy/deletionJobs";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { FourReversiProgress } from "../src/rooms/fourReversiProgress";
import {
  currentRoomStateVersion,
  roomStateVersionKey,
} from "../src/adapters/room/roomStateVersion";
import { accountFixture } from "./accountFixtures";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});

test("着手と投了は状態・本人・時計・脱落・手番の順で拒否し、拒否で棋譜を変えない", async () => {
  const entry = await fixtures.create({
    game: "four-reversi",
    name: "ホスト",
    quickPlay: true,
    cpuLevel: 1,
    mode: "singles",
  });
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), (_, ctx) => {
    const waiting = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
    if (waiting.status !== "waiting") throw Error("Expected waiting");
    const progress = new FourReversiProgress({
      storage: ctx.storage,
      accountId: () => null,
      membership: (id) => (id === "unknown" ? null : { playerId: id, role: "player" }),
    });
    const { room } = progress.start(waiting);
    const current = room.players.find((p) => p.color === room.game.turn)!;
    const other = room.players.find((p) => p.color !== room.game.turn)!;
    const expired = { ...room, clock: { ...room.clock, turnExpiresAt: Date.now() } };
    const command: GameActionCommandFor<"four-reversi"> = {
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
    };
    const before = ctx.storage.kv.get("round-replay");
    const cases: [FourReversiRoom, string, string][] = [
      [waiting, "unknown", "game_not_started"],
      [expired, "unknown", "unauthorized"],
      [expired, "missing-player", "unauthorized"],
      [expired, other.id, "time_expired"],
      [
        { ...expired, game: { ...expired.game, eliminatedColors: [other.color] } },
        other.id,
        "time_expired",
      ],
      [
        { ...room, game: { ...room.game, eliminatedColors: [other.color] } },
        other.id,
        "already_eliminated",
      ],
      [room, other.id, "not_your_turn"],
    ];
    for (const [input, token, error] of cases) {
      expect(progress.play(input, token, command)).toEqual({ kind: "rejected", error });
      expect(progress.resign(input, token)).toEqual({ kind: "rejected", error });
    }
    const stale = { ...command, roundId: crypto.randomUUID() };
    expect(progress.play(expired, "unknown", stale)).toEqual({
      kind: "rejected",
      error: "unauthorized",
    });
    expect(progress.play(expired, other.id, stale)).toEqual({
      kind: "rejected",
      error: "stale_position",
    });
    const eliminated = { ...room, game: { ...room.game, eliminatedColors: [other.color] } };
    expect(progress.play(eliminated, other.id, stale)).toEqual({
      kind: "rejected",
      error: "stale_position",
    });
    expect(ctx.storage.kv.get("round-replay")).toEqual(before);
    expect(progress.play(room, current.id, command).kind).toBe("playing");
  });
});

async function startFourPlayers(hostCookie?: string) {
  const entry = await fixtures.create(
    { game: "four-reversi", name: "ホスト", quickPlay: false, mode: "singles" },
    hostCookie,
  );
  expect(entry.room).not.toHaveProperty("roundId");
  expect(entry.room).not.toHaveProperty("positionRevision");
  expect((await fixtures.snapshot(entry.room.id)).room).toMatchObject({
    roundId: null,
    positionRevision: 0,
  });
  const entries = [entry];
  for (const name of ["二人目", "三人目", "四人目"]) {
    const joined = await fixtures.join(entry.room.id, name);
    expect(joined.room).not.toHaveProperty("roundId");
    expect(joined.room).not.toHaveProperty("positionRevision");
    entries.push(joined);
  }
  const host = hostCookie ? await fixtures.open(entry.room.id) : await fixtures.connect(entry);
  if (hostCookie) {
    host.send({ type: "room.auth", token: entry.membership.token });
    await host.waitFor("room.authenticated");
    await host.waitFor("room.snapshot", (m) =>
      m.presence.connectedPlayerIds.includes(entry.membership.playerId),
    );
  }
  const sockets = [
    host,
    ...(await Promise.all(entries.slice(1).map((player) => fixtures.connect(player)))),
  ];
  for (const [index, socket] of sockets.entries()) {
    const id = entries[index]!.membership.playerId;
    socket.send({ type: "room.ready.set", ready: true });
    await host.waitFor("room.snapshot", (m) => m.room.players.some((p) => p.id === id && p.ready));
  }
  host.send({ type: "room.game.start" });
  const started = await Promise.all(
    sockets.map((socket) => socket.waitFor("room.snapshot", (m) => m.room.status === "playing")),
  );
  const room = fourReversiRoomSchema.parse(started[0]!.room);
  if (room.status !== "playing") throw new Error("Expected playing");
  const playerIndex = (color: string) =>
    entries.findIndex((e) =>
      room.players.some((p) => p.id === e.membership.playerId && p.color === color),
    );
  return {
    room,
    entries,
    host,
    sockets,
    playerIndex,
    stub: env.GAME_ROOM.getByName(room.id),
  };
}

test("局IDと版が一致する着手だけを適用し、拒否には最新の盤面を返す", async () => {
  const { room, sockets, playerIndex, stub } = await startFourPlayers();
  const mover = sockets[playerIndex(room.game.turn)]!;
  const replay = () =>
    runInDurableObject(stub, (_, ctx) =>
      ctx.storage.kv.get<{ id: string; steps: unknown[] }>("round-replay")!,
    );
  const initialReplay = await replay();
  const move = {
    type: "room.game.action",
    action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
  } as const;
  const roundId = initialReplay.id;
  const valid = { ...move, roundId, positionRevision: 0 };
  expect(room).toMatchObject({ roundId, positionRevision: 0 });
  expect((await fixtures.snapshot(room.id)).room).toEqual(room);
  for (const input of [
    move,
    { ...move, roundId },
    { ...move, positionRevision: 0 },
    { ...valid, roundId: "invalid" },
    { ...valid, positionRevision: -1 },
  ]) {
    expect(roomSocketContract.clientMessage.safeParse(input).success).toBe(false);
    mover.send(input);
    expect((await mover.waitFor("room.error")).error).toBe("invalid_request");
    expect((await mover.waitFor("room.snapshot", (m) => m.room.status === "playing")).room).toEqual(
      room,
    );
  }
  mover.send({ ...valid, roundId: crypto.randomUUID() });
  expect((await mover.waitFor("room.error")).error).toBe("stale_position");
  expect((await mover.waitFor("room.snapshot", (m) => m.room.status === "playing")).room).toEqual(
    room,
  );
  expect(await replay()).toEqual(initialReplay);

  mover.send(valid);
  const moved = fourReversiRoomSchema.parse(
    (await mover.waitFor("room.snapshot", (m) => m.room.game?.moveNumber === 1)).room,
  );
  expect(moved).toMatchObject({ roundId, positionRevision: 1 });
  const movedReplay = await replay();
  expect(movedReplay.steps).toHaveLength(1);
  for (const [socket, input] of [
    [mover, valid],
    [
      sockets[playerIndex(moved.game!.turn)]!,
      { ...valid, action: { ...move.action, position: getLegalMoves(moved.game!)[0]! } },
    ],
  ] as const) {
    socket.send(input);
    expect((await socket.waitFor("room.error")).error).toBe("stale_position");
    expect(
      (await socket.waitFor("room.snapshot", (m) => m.room.game?.moveNumber === 1)).room,
    ).toEqual(moved);
  }
  expect((await fixtures.snapshot(room.id)).room).toEqual(moved);
  expect(await replay()).toEqual(movedReplay);
});

test("退会受付後の不正な着手に旧名と画像を返さない", async () => {
  const account = await accountFixture();
  const preset = avatarPresets[0].id;
  await env.APP_DB.prepare("UPDATE user SET avatarPresetId=? WHERE id=?")
    .bind(preset, account.id)
    .run();
  const { room, entries, host, sockets, stub } = await startFourPlayers(account.cookie);
  const entry = entries[0]!;
  const playerId = entry.membership.playerId;
  const color = room.players.find((player) => player.id === playerId)!.color;
  const socket = sockets[1]!;
  const original = { id: playerId, name: "登録名", avatarUrl: avatarPresetUrl(preset) };
  expect(room.players).toContainEqual(expect.objectContaining(original));

  host.close();
  await socket.waitFor("room.snapshot", (m) => !m.presence.connectedPlayerIds.includes(playerId));
  await fixtures.leave(entry);
  await socket.waitFor(
    "room.snapshot",
    (m) => isFourReversiRoom(m.room) && !!m.room.game?.eliminatedColors.includes(color),
  );
  expect(await requestDeletion(env, account.id, crypto.randomUUID())).toBe(true);
  expect(await readRoomDeletionAccounts(env.APP_DB, room.id)).toContain(account.id);
  await runInDurableObject(stub, (_, ctx) => {
    const saved = fourReversiRoomSchema.parse(ctx.storage.kv.get("room"));
    expect(saved.players).toContainEqual(expect.objectContaining(original));
  });

  socket.send({
    type: "room.game.action",
    roundId: "invalid",
    positionRevision: room.positionRevision,
    action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
  });
  expect((await socket.waitFor("room.error")).error).toBe("invalid_request");
  // 退会反映の配信と着手拒否の応答を両方確認します。
  for (let count = 0; count < 2; count++) {
    const { room: received } = await socket.waitFor("room.snapshot");
    expect(received.players.find((player) => player.id === playerId)).toMatchObject({
      name: "退会したプレイヤー",
      avatarUrl: null,
    });
  }
});

test("切り戻し中に局面が進んだ対局を再移行すると、切り戻し前の着手を拒否する", async () => {
  const { room, sockets, playerIndex, stub } = await startFourPlayers();
  const { roundId, positionRevision, ...versionOneRoom } = room;
  const position = getLegalMoves(room.game)[0]!;
  const mover = sockets[playerIndex(room.game.turn)]!;
  const delayed = {
    type: "room.game.action",
    roundId,
    positionRevision,
    action: { type: "placeStone", position },
  } as const;

  await runInDurableObject(stub, (_, ctx) => {
    expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
    // TB-160 の切り戻し時と同様に、照合の項目を外して版1に戻します。
    ctx.storage.transactionSync(() => {
      ctx.storage.kv.put("room", versionOneRoom);
      ctx.storage.kv.put(roomStateVersionKey, 1);
    });
  });
  await evictDurableObject(stub, { webSockets: "hibernate" });

  const { advanced, replay } = await runInDurableObject(stub, (_, ctx) => {
    expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(1);
    const saved = ctx.storage.kv.get<typeof versionOneRoom>("room")!;
    expect(saved).not.toHaveProperty("roundId");
    expect(saved).not.toHaveProperty("positionRevision");
    const other = saved.players.find((player) => player.color !== saved.game.turn)!;
    const progress = new FourReversiProgress({
      storage: ctx.storage,
      accountId: () => null,
      membership: () => null,
    });
    return ctx.storage.transactionSync(() => {
      const result = progress.eliminate(
        { ...saved, roundId, positionRevision },
        other.id,
        "disconnected",
        Date.now(),
      );
      if (result.kind !== "playing") throw Error("Expected playing");
      const { roundId: _roundId, positionRevision: _revision, ...advanced } = result.room;
      ctx.storage.kv.put("room", advanced);
      const replay = roundReplaySchema.parse(ctx.storage.kv.get("round-replay"));
      return { advanced, replay };
    });
  });
  expect(advanced.game.turn).toBe(room.game.turn);
  expect(getLegalMoves(advanced.game)).toContainEqual(position);
  expect(replay.steps).toHaveLength(1);
  await evictDurableObject(stub, { webSockets: "hibernate" });
  const migrated = await stub.getRoom();
  expect(migrated?.game).toEqual(advanced.game);
  await runInDurableObject(stub, (_, ctx) => {
    expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
  });

  mover.send(delayed);
  const reply = await mover.waitFor("room.snapshot", (m) => m.room.status === "playing");
  expect(reply.room.game).toEqual(advanced.game);
  expect((await mover.waitFor("room.error")).error).toBe("stale_position");
  expect(reply.room).toEqual(migrated);
  expect(reply.room).toMatchObject({ positionRevision: 0 });
  expect(reply.room.roundId).not.toBe(roundId);
  expect(await runInDurableObject(stub, (_, ctx) => ctx.storage.kv.get("round-replay"))).toEqual(
    replay,
  );
});

test.each([undefined, 1] as const)(
  "旧DO（保存版 %s）は新しい照合用IDを使い、保存済みの対局情報と盤面を維持する",
  async (version) => {
    const { room, stub } = await startFourPlayers();
    const records = await runInDurableObject(stub, (_, ctx) => {
      const saved = ctx.storage.kv.get<Record<string, unknown>>("room")!;
      delete saved.roundId;
      delete saved.positionRevision;
      ctx.storage.kv.put("room", saved);
      if (version === undefined) {
        ctx.storage.kv.delete("room-state-version");
        ctx.storage.kv.delete("match-start");
      } else {
        ctx.storage.kv.put("room-state-version", version);
        ctx.storage.kv.delete("round-replay");
      }
      return {
        start: ctx.storage.kv.get("match-start"),
        replay: ctx.storage.kv.get("round-replay"),
      };
    });
    await evictDurableObject(stub, { webSockets: "hibernate" });
    expect(await stub.getShareMetadata(room.instanceId)).not.toBeNull();
    await runInDurableObject(stub, (_, ctx) => {
      expect(ctx.storage.kv.get("room")).not.toHaveProperty("roundId");
      expect(ctx.storage.kv.get("room-state-version")).toBe(version);
    });
    const after = await stub.getRoom();
    expect(after).toMatchObject({
      game: room.game,
      roundId: expect.any(String),
      positionRevision: 0,
    });
    expect(after?.roundId).not.toBe(room.roundId);
    await runInDurableObject(stub, (_, ctx) => {
      expect(ctx.storage.kv.get("room-state-version")).toBe(2);
      expect(ctx.storage.kv.get("match-start")).toEqual(records.start);
      expect(ctx.storage.kv.get("round-replay")).toEqual(records.replay);
    });
    await evictDurableObject(stub, { webSockets: "hibernate" });
    expect(await stub.getRoom()).toEqual(after);
  },
);

test("開始情報と棋譜のない旧DOは再起動後も同じ照合用IDを使う", async () => {
  const { room, stub, playerIndex, sockets } = await startFourPlayers();
  await runInDurableObject(stub, (_, ctx) => {
    const saved = ctx.storage.kv.get<Record<string, unknown>>("room")!;
    delete saved.roundId;
    delete saved.positionRevision;
    ctx.storage.kv.put("room", saved);
    ctx.storage.kv.delete("room-state-version");
    ctx.storage.kv.delete("match-start");
    ctx.storage.kv.delete("round-replay");
  });
  const after = await stub.getRoom();
  expect(after).toMatchObject({
    game: room.game,
    roundId: expect.any(String),
    positionRevision: 0,
  });
  await evictDurableObject(stub, { webSockets: "hibernate" });
  expect(await stub.getRoom()).toEqual(after);
  const migrated = fourReversiRoomSchema.parse(after);
  if (migrated.status !== "playing") throw new Error("Expected migrated game");
  const mover = sockets[playerIndex(room.game.turn)]!;
  mover.send({
    type: "room.game.action",
    roundId: migrated.roundId,
    positionRevision: migrated.positionRevision,
    action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
  });
  expect(
    (await mover.waitFor("room.snapshot", (m) => m.room.game?.moveNumber === 1)).room,
  ).toMatchObject({ roundId: migrated.roundId, positionRevision: 1 });
  await runInDurableObject(stub, (_, ctx) => {
    expect(ctx.storage.kv.get("match-start")).toBeUndefined();
    expect(ctx.storage.kv.get("round-replay")).toBeUndefined();
  });
});
