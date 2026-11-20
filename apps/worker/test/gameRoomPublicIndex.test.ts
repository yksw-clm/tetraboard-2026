import { fixTestTime } from "./fixedTimeFixture";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  listRoomsContract,
  fourReversiRoomSchema as roomSchema,
  roomPublicMetadataSchema,
  roomTimeControl,
  type RoomPublicMetadata,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { expect, test, vi } from "vitest";
import { writeRoomIndex } from "../src/adapters/room/roomIndexWrite";
import worker from "../src/worker";
import {
  registerGameRoomFixtures,
  createRoom,
  getMetadata,
  joinRoom,
  authenticatedRoom,
  waitForIndexedRoom,
  listRooms,
  getRoom,
  leaveRoom,
  fourPlayers,
  readyPlayers,
  indexedRoom,
  baseUrl,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test("公開メタデータは参加・CPU席・ホスト交代を反映し、閉鎖時は消える", async () => {
  const created = await createRoom();
  const id = created.room.id;
  const initial = await getMetadata(id);
  expect(initial).toEqual({
    id,
    game: "four-reversi",
    mode: "singles",
    timeControl: roomTimeControl,
    status: "waiting",
    hostName: "ホスト",
    hostAvatarUrl: null,
    humanCount: 1,
    cpuCount: 0,
    capacity: 4,
    openSeats: 3,
    updatedAtMs: created.room.publicUpdatedAtMs,
  });
  expect(roomPublicMetadataSchema.safeParse({ ...initial, openSeats: 0 }).success).toBe(false);

  const joined = await joinRoom(id, "二人目");
  const afterJoin = await getMetadata(id);
  expect(afterJoin?.humanCount).toBe(2);
  expect(afterJoin?.openSeats).toBe(2);
  expect(afterJoin!.updatedAtMs).toBeGreaterThan(initial!.updatedAtMs);

  const host = await authenticatedRoom(id, created.membership.token);
  const guest = await authenticatedRoom(id, joined.membership.token);
  host.send({ type: "room.cpu.add", level: 1 });
  await host.nextSnapshotWhere((room) => room.players.length === 3);
  const afterCpu = await getMetadata(id);
  expect(afterCpu?.cpuCount).toBe(1);
  expect(afterCpu?.openSeats).toBe(1);
  expect(afterCpu!.updatedAtMs).toBeGreaterThan(afterJoin!.updatedAtMs);
  await waitForIndexedRoom(id, (row) => row.updated_at_ms === afterCpu!.updatedAtMs);
  expect((await listRooms()).rooms.find((room) => room.id === id)?.cpuCount).toBe(1);

  const cpu = (await getRoom(id)).players.find((player) => player.kind === "cpu");
  if (cpu?.kind !== "cpu") throw new Error("CPU was not added");
  host.send({ type: "room.cpu.level.set", playerId: cpu.id, level: 2 });
  await host.nextSnapshotWhere((room) =>
    room.players.some(
      (player) => player.id === cpu.id && player.kind === "cpu" && player.level === 2,
    ),
  );
  const afterLevel = await getMetadata(id);
  expect(afterLevel?.cpuCount).toBe(1);
  expect(afterLevel!.updatedAtMs).toBeGreaterThan(afterCpu!.updatedAtMs);

  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  await guest.nextSnapshotWhere((room) => room.players[0]?.name === "二人目");
  const afterHandoff = await getMetadata(id);
  expect(afterHandoff?.hostName).toBe("二人目");
  expect(afterHandoff?.humanCount).toBe(1);
  expect(afterHandoff?.cpuCount).toBe(1);
  expect(afterHandoff!.updatedAtMs).toBeGreaterThan(afterLevel!.updatedAtMs);

  guest.send({ type: "room.cpu.remove", playerId: cpu.id });
  await guest.nextSnapshotWhere((room) => room.players.length === 1);
  const afterRemove = await getMetadata(id);
  expect(afterRemove?.cpuCount).toBe(0);
  expect(afterRemove?.openSeats).toBe(3);
  expect(afterRemove!.updatedAtMs).toBeGreaterThan(afterHandoff!.updatedAtMs);
  await waitForIndexedRoom(id, (row) => row.updated_at_ms === afterRemove!.updatedAtMs);
  expect((await listRooms()).rooms.find((room) => room.id === id)?.cpuCount).toBe(0);

  expect((await leaveRoom(id, joined.membership.token)).status).toBe(204);
  expect(await getMetadata(id)).toBeNull();
});

test("ダブルス開始と終局は公開情報を更新し、通常の着手は更新しない", async () => {
  const setup = await fourPlayers();
  setup.connections[0].send({ type: "room.mode.set", mode: "doubles" });
  await setup.connections[0].nextSnapshotWhere((room) => room.settings.mode === "doubles");
  await readyPlayers(setup.id, setup.connections);
  const waiting = await getMetadata(setup.id);

  setup.connections[0].send({ type: "room.game.start" });
  const started = await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  expect(started.game.mode).toBe("doubles");
  expect(
    roomSchema.safeParse({ ...started, settings: { ...started.settings, mode: "singles" } })
      .success,
  ).toBe(false);
  expect(new Set(started.players.map((player) => player.color)).size).toBe(4);
  const playing = await getMetadata(setup.id);
  expect(playing?.status).toBe("playing");
  expect(playing?.openSeats).toBe(0);
  expect(playing!.updatedAtMs).toBeGreaterThan(waiting!.updatedAtMs);
  const indexedBeforeMove = await waitForIndexedRoom(
    setup.id,
    (row) => row.status === "playing" && row.updated_at_ms === playing!.updatedAtMs,
  );

  setup.connections[1].send({ type: "room.mode.set", mode: "singles" });
  expect((await setup.connections[1].nextType("room.error")).error).toBe("already_started");

  const black = started.players.findIndex((player) => player.color === "black");
  setup.connections[black].send({
    type: "room.game.action",
    roundId: started.roundId,
    positionRevision: started.positionRevision,
    action: { type: "placeStone", position: getLegalMoves(started.game)[0] },
  });
  await setup.connections[0].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 1,
  );
  expect((await getMetadata(setup.id))?.updatedAtMs).toBe(playing!.updatedAtMs);
  expect(await indexedRoom(setup.id)).toEqual(indexedBeforeMove);

  expect((await leaveRoom(setup.id, setup.participants[0].token)).status).toBe(204);
  const finished = await setup.connections[1].nextSnapshotWhere(
    (room) => room.status === "waiting" && room.lastRound !== null,
  );
  if (finished.status !== "waiting" || finished.lastRound?.game.result.mode !== "doubles") {
    throw new Error("Doubles game did not finish");
  }
  expect(finished.lastRound.game.result.reason).toBe("team_eliminated");
  const hostColor = finished.lastRound.players.find(
    (player) => player.id === setup.participants[0].playerId,
  )?.color;
  expect(finished.lastRound.game.result.winner).toBe(
    hostColor === "black" || hostColor === "red" ? "white-blue" : "black-red",
  );
  const metadata = await getMetadata(setup.id);
  expect(metadata?.status).toBe("waiting");
  expect(metadata?.hostName).toBe("参加者2");
  expect(metadata?.humanCount).toBe(3);
  expect(metadata!.updatedAtMs).toBeGreaterThan(playing!.updatedAtMs);
  await waitForIndexedRoom(setup.id, (row) => row.status === "waiting");
});

test("D1の公開索引は作成・入室・ホスト交代・閉鎖を反映する", async () => {
  const created = await createRoom();
  const id = created.room.id;
  await waitForIndexedRoom(id, (row) => row.revision === 1 && row.closed === 0);
  expect((await listRooms()).rooms.some((room) => room.id === id)).toBe(true);

  const joined = await joinRoom(id, "二人目");
  await waitForIndexedRoom(id, (row) => row.revision === 2 && row.closed === 0);
  expect((await listRooms()).rooms.find((room) => room.id === id)?.humanCount).toBe(2);

  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  await waitForIndexedRoom(id, (row) => row.revision === 3 && row.host_name === "二人目");
  expect((await listRooms()).rooms.find((room) => room.id === id)?.hostName).toBe("二人目");

  expect((await leaveRoom(id, joined.membership.token)).status).toBe(204);
  await waitForIndexedRoom(id, (row) => row.revision === 4 && row.closed === 1);
  expect((await listRooms()).rooms.some((room) => room.id === id)).toBe(false);
});

test("CPU席・モード・開始・終了は索引を更新し、通常の着手は更新しない", async () => {
  const created = await createRoom(true, "singles");
  const id = created.room.id;
  const host = await authenticatedRoom(id, created.membership.token);
  const initial = await waitForIndexedRoom(id, (row) => row.revision === 1);
  host.send({ type: "room.cpu.level.set", playerId: created.room.players[1].id, level: 2 });
  await host.nextSnapshotWhere(
    (room) => room.players[1].kind === "cpu" && room.players[1].level === 2,
  );
  await waitForIndexedRoom(id, (row) => row.revision > initial.revision);

  host.send({ type: "room.mode.set", mode: "doubles" });
  await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  await vi.waitFor(async () => {
    expect((await listRooms()).rooms.find((room) => room.id === id)?.mode).toBe("doubles");
  });
  host.send({ type: "room.ready.set", ready: true });
  await host.nextSnapshotWhere((room) => room.players[0].ready);
  const beforeStart = await indexedRoom(id);
  host.send({ type: "room.game.start" });
  const playing = await host.nextSnapshotWhere((room) => room.status === "playing");
  if (playing.status !== "playing") throw new Error("Game did not start");
  await waitForIndexedRoom(
    id,
    (row) => row.revision > beforeStart!.revision && row.status === "playing",
  );

  const beforeMove = await indexedRoom(id);
  const black = playing.players.find((player) => player.color === "black");
  if (black?.kind === "human") {
    host.send({
      type: "room.game.action",
      roundId: playing.roundId,
      positionRevision: playing.positionRevision,
      action: { type: "placeStone", position: getLegalMoves(playing.game)[0] },
    });
    await host.nextSnapshotWhere((room) => room.status === "playing" && room.game.moveNumber === 1);
    expect(await indexedRoom(id)).toEqual(beforeMove);
  }

  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  await waitForIndexedRoom(id, (row) => row.closed === 1);
  expect((await listRooms()).rooms.find((room) => room.id === id)).toBeUndefined();
});

test("一覧は同じ更新時刻でも部屋番号順で20件ずつ取得し、不正カーソルを拒否する", async () => {
  // APP_DB retains earlier room revisions and receives asynchronous GameRoom writes.
  const db = (env as typeof env & { ROOM_INDEX_TEST_DB: D1Database }).ROOM_INDEX_TEST_DB;
  await applyD1Migrations(
    db,
    (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
  const request = (cursor?: string) =>
    worker.fetch(
      new AcceptedGameRequest(
        `${baseUrl}${listRoomsContract.path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
      { ...env, APP_DB: db },
      {} as ExecutionContext,
    );
  const updatedAtMs = 1_700_000_000_000;
  const base: RoomPublicMetadata = {
    id: "99900",
    game: "four-reversi",
    mode: "singles",
    timeControl: roomTimeControl,
    status: "waiting",
    hostName: "テスト",
    hostAvatarUrl: null,
    humanCount: 1,
    cpuCount: 0,
    capacity: 4,
    openSeats: 3,
    updatedAtMs,
  };
  for (let index = 0; index < 22; index++) {
    await writeRoomIndex(db, {
      metadata: { ...base, id: String(99900 + index) },
      revision: 1,
      closed: false,
      retryAtMs: 0,
    });
  }
  const firstResponse = await request();
  expect(firstResponse.status).toBe(200);
  const first = listRoomsContract.response.parse(await firstResponse.json());
  expect(first.rooms).toHaveLength(20);
  expect(first.rooms.map((room) => room.id)).toEqual(
    Array.from({ length: 20 }, (_, index) => String(99921 - index)),
  );
  expect(first.nextCursor).toBe(`${updatedAtMs}:99902`);
  const secondResponse = await request(first.nextCursor!);
  expect(secondResponse.status).toBe(200);
  const second = listRoomsContract.response.parse(await secondResponse.json());
  expect(second.rooms.map((room) => room.id)).toEqual(["99901", "99900"]);
  expect(second.nextCursor).toBeNull();
  const invalid = await request("invalid");
  expect(invalid.status).toBe(400);
});

test("古い索引更新は部屋番号再利用後の新しい更新を上書きしない", async () => {
  const created = await createRoom();
  const id = created.room.id;
  await waitForIndexedRoom(id, (row) => row.revision === 1);
  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  await waitForIndexedRoom(id, (row) => row.revision === 2 && row.closed === 1);

  const replacement = roomSchema.parse({
    ...created.room,
    instanceId: crypto.randomUUID(),
    lastActivityAtMs: Date.now(),
    players: [{ ...created.room.players[0], id: crypto.randomUUID(), name: "新ホスト" }],
    publicUpdatedAtMs: Date.now(),
  });
  const newRoom = await env.GAME_ROOM.getByName(id).createRoom(replacement, "a".repeat(64));
  expect(newRoom?.players[0].name).toBe("新ホスト");
  await waitForIndexedRoom(id, (row) => row.revision === 3 && row.closed === 0);
  await writeRoomIndex(env.APP_DB, {
    metadata: roomPublicMetadataSchema.parse({
      ...(await getMetadata(id)),
      hostName: "古いホスト",
    }),
    revision: 2,
    closed: true,
    retryAtMs: 0,
  });
  expect((await indexedRoom(id))?.host_name).toBe("新ホスト");
  expect((await indexedRoom(id))?.closed).toBe(0);
});

test("D1障害中も部屋を作成し、Alarmで索引反映を再試行する", async () => {
  fixTestTime();
  await env.APP_DB.exec("ALTER TABLE room_index RENAME TO room_index_unavailable");
  let created!: Awaited<ReturnType<typeof createRoom>>;
  try {
    created = await createRoom();
    await vi.waitFor(async () => {
      const pending = await runInDurableObject(
        env.GAME_ROOM.getByName(created.room.id),
        (_instance, state) => state.storage.kv.get<{ retryAtMs: number }>("room-index-pending"),
      );
      expect(pending?.retryAtMs).toBeGreaterThan(Date.now());
    });
  } finally {
    await env.APP_DB.exec("ALTER TABLE room_index_unavailable RENAME TO room_index");
  }
  const stub = env.GAME_ROOM.getByName(created.room.id);
  await runInDurableObject(stub, async (_instance, state) => {
    const pending = state.storage.kv.get<{ retryAtMs: number }>("room-index-pending");
    if (!pending) throw new Error("Missing pending index update");
    state.storage.kv.put("room-index-pending", { ...pending, retryAtMs: Date.now() - 1 });
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await waitForIndexedRoom(created.room.id, (row) => row.closed === 0);
});
