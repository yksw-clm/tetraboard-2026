import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  createRoomContract,
  getRoomContract,
  getRoomMembershipContract,
  joinRoomContract,
  leaveRoomContract,
  listRoomsContract,
  listReportsContract,
  moderateReportContract,
  reportContract,
  fourReversiRoomSchema as roomSchema,
  roundReplaySchema,
  roomPublicMetadataSchema,
  roomSocketContract,
  roomTimeControl,
  viewerContract,
  type FourReversiRoom as Room,
  type RoomMode,
  type RoomTimeControl,
  type RoomPublicMetadata,
  type RoomSocketClientMessage,
  type RoomSocketMessage as ProtocolRoomSocketMessage,
} from "@tetraboard/protocol";
import { applyAction, createInitialState, getLegalMoves } from "@tetraboard/four-reversi";
import { afterEach, expect, test, vi } from "vitest";
import { writeRoomIndex } from "../src/rooms/roomIndex";
import worker from "../src/worker";

type RoomSocketMessage =
  | Exclude<ProtocolRoomSocketMessage, { type: "room.snapshot" }>
  | (Omit<Extract<ProtocolRoomSocketMessage, { type: "room.snapshot" }>, "room"> & { room: Room });
function parseReversiMessage(value: unknown): RoomSocketMessage {
  const message = roomSocketContract.message.parse(value);
  return message.type === "room.snapshot"
    ? { ...message, room: roomSchema.parse(message.room) }
    : message;
}

const baseUrl = "https://example.com";

test("接続情報は観戦者にも配信し、脱落後の切断と復帰も反映する", async () => {
  const setup = await startFourPlayerRoom();
  const observer = await openRoom(setup.id);
  expect(observer.initialSnapshot?.presence.hostPlayerId).toBe(setup.participants[0].playerId);
  expect(observer.initialSnapshot?.presence.connectedPlayerIds).toHaveLength(4);
  const index = setup.room.players.findIndex((player) => player.color === setup.room.game.turn);
  const playerId = setup.participants[index].playerId;
  setup.connections[index].send({ type: "room.game.resign" });
  await observer.nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.eliminatedColors.length === 1,
  );
  setup.connections[index].close();
  let snapshot;
  do {
    snapshot = await observer.nextType("room.snapshot");
  } while (snapshot.presence.connectedPlayerIds.includes(playerId));
  expect(snapshot.room.players).toHaveLength(4);
  expect(
    snapshot.room.players.find((player) => player.id === playerId)?.reconnectDeadline,
  ).toBeGreaterThan(Date.now());
  await authenticatedRoom(setup.id, setup.participants[index].token);
  do {
    snapshot = await observer.nextType("room.snapshot");
  } while (!snapshot.presence.connectedPlayerIds.includes(playerId));
  expect(snapshot.room.players).toHaveLength(4);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${setup.id}`),
  );
  expect(getRoomContract.response.parse(await response.json()).presence).toEqual(snapshot.presence);
});

test("入退室・CPU操作・モード変更のログは一度だけ記録し、再接続では追加しない", async () => {
  const created = await createRoom();
  const id = created.room.id;
  const host = await authenticatedRoom(id, created.membership.token);
  const observer = await openRoom(id);
  const initial = await observer.nextChatWhere((entries) => entries.length === 1);
  expect(initial[0]).toMatchObject({
    kind: "system",
    event: "joined",
    text: "ホストが入室しました",
  });
  const joined = await joinRoom(id, "二人目");
  const player = await authenticatedRoom(id, joined.membership.token);
  await host.nextChatWhere((entries) => entries.at(-1)?.text === "二人目が入室しました");
  host.send({ type: "room.cpu.add", level: 2 });
  const withCpu = await host.nextSnapshotWhere((room) => room.players.length === 3);
  const cpu = withCpu.players.find((entry) => entry.kind === "cpu")!;
  await host.nextChatWhere((entries) => entries.at(-1)?.text === "CPU Lv2が入室しました");
  host.send({ type: "room.cpu.remove", playerId: cpu.id });
  await host.nextChatWhere((entries) => entries.at(-1)?.text === "CPU Lv2が退室しました");
  host.send({ type: "room.mode.set", mode: "doubles" });
  await host.nextChatWhere(
    (entries) => entries.at(-1)?.text === "対局形式がダブルスに変更されました",
  );
  host.send({ type: "room.mode.set", mode: "doubles" });
  await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  player.close();
  await expectPending(id, joined.membership.playerId);
  await authenticatedRoom(id, joined.membership.token);
  const reloaded = await openRoom(id);
  const history = await reloaded.nextChatWhere((entries) => entries.length === 5);
  expect(
    history.filter((entry) => entry.kind === "system" && entry.event === "mode_changed"),
  ).toHaveLength(1);
  expect((await leaveRoom(id, joined.membership.token)).status).toBe(204);
  const afterLeave = await host.nextChatWhere(
    (entries) => entries.at(-1)?.text === "二人目が退室しました",
  );
  expect(afterLeave.filter((entry) => entry.text === "二人目が退室しました")).toHaveLength(1);
  const report = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${id}/reports`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.membership.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: initial[0].id }),
    }),
  );
  expect(report.status).toBe(404);
});

test("新規投稿は絵文字を含め100文字までとし、旧200文字履歴も閲覧・通報できる", async () => {
  const created = await createRoom();
  const id = created.room.id;
  const host = await authenticatedRoom(id, created.membership.token);
  const legacy = {
    id: crypto.randomUUID(),
    senderId: created.membership.playerId,
    senderName: "ホスト",
    text: "あ".repeat(200),
    sentAtMs: Date.now(),
  };
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    state.storage.kv.put("chat", [legacy]);
  });
  const observer = await openRoom(id);
  expect(
    (await observer.nextChatWhere((entries) => entries[0]?.id === legacy.id))[0],
  ).toMatchObject({ kind: "player", text: legacy.text });
  host.send({ type: "room.chat.send", text: "👨‍👩‍👧‍👦".repeat(100) });
  expect((await observer.nextChatWhere((entries) => entries.length === 2)).at(-1)?.text).toBe(
    "👨‍👩‍👧‍👦".repeat(100),
  );
  host.send({ type: "room.chat.send", text: "👨‍👩‍👧‍👦".repeat(101) });
  expect((await host.nextType("room.chat.error")).error).toBe("invalid_request");
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${id}/reports`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.membership.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: legacy.id }),
    }),
  );
  expect(response.status).toBe(201);
});

test("対局中の復帰期限切れログは、終局時に重複せずカード情報も残す", async () => {
  const { id, participants, connections, room } = await startFourPlayerRoom();
  const observer = await openRoom(id);
  const player = participants[1];
  connections[1].close();
  await expectPending(id, player.playerId);
  await expirePlayers(id, [player.playerId]);
  const entries = await observer.nextChatWhere((messages) =>
    messages.some((entry) => entry.text === "参加者2が退室しました"),
  );
  expect(entries.filter((entry) => entry.text === "参加者2が退室しました")).toHaveLength(1);
  expect((await getRoom(id)).players).toHaveLength(4);
  const remaining = room.players.filter((entry) => entry.id !== player.playerId);
  for (const entry of remaining.slice(1)) {
    const member = participants.find((participant) => participant.playerId === entry.id)!;
    await leaveRoom(id, member.token);
  }
  const after = await openRoom(id);
  const history = await after.nextChatWhere((messages) =>
    messages.some((entry) => entry.text === "参加者2が退室しました"),
  );
  expect(history.filter((entry) => entry.text === "参加者2が退室しました")).toHaveLength(1);
});

const clients: RoomClient[] = [];

class RoomClient {
  private readonly messages: RoomSocketMessage[] = [];
  private readonly waiters: ((message: RoomSocketMessage) => void)[] = [];
  initialSnapshot: Extract<RoomSocketMessage, { type: "room.snapshot" }> | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = parseReversiMessage(JSON.parse(String(event.data)));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
    socket.accept();
  }

  send(message: RoomSocketClientMessage): void {
    this.sendRaw(roomSocketContract.clientMessage.parse(message));
  }

  sendRaw(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  private next(): Promise<RoomSocketMessage> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const receive = (message: RoomSocketMessage) => {
        clearTimeout(timeout);
        resolve(message);
      };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(receive);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for a room message"));
      }, 5_000);
      this.waiters.push(receive);
    });
  }

  async nextType<T extends RoomSocketMessage["type"]>(
    type: T,
  ): Promise<Extract<RoomSocketMessage, { type: T }>> {
    for (;;) {
      const message = await this.next();
      if (message.type === type) return message as Extract<RoomSocketMessage, { type: T }>;
    }
  }

  async nextSnapshotWhere(predicate: (room: Room) => boolean): Promise<Room> {
    for (;;) {
      const message = await this.nextType("room.snapshot");
      if (predicate(message.room)) return message.room;
    }
  }

  async nextChatWhere(
    predicate: (
      messages: Extract<RoomSocketMessage, { type: "room.chat.snapshot" }>["messages"],
    ) => boolean,
  ) {
    for (;;) {
      const message = await this.nextType("room.chat.snapshot");
      if (predicate(message.messages)) return message.messages;
    }
  }

  close(): void {
    this.socket.close(1000, "test complete");
  }
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function createRoom(
  quickPlay = false,
  mode: RoomMode = "singles",
  timeControl?: RoomTimeControl,
) {
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${createRoomContract.path}`, {
      method: createRoomContract.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ホスト", quickPlay, mode, timeControl }),
    }),
  );
  expect(response.status).toBe(201);
  const result = createRoomContract.response.parse(await response.json());
  return { ...result, room: roomSchema.parse(result.room) };
}

test("招待先と同じ世代に参加し、既存の番号参加も引き続き利用できる", async () => {
  const { room, membership } = await createRoom();
  const host = await authenticatedRoom(room.id, membership.token);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${room.id}/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "招待された人", instanceId: room.instanceId }),
    }),
  );
  expect(response.status).toBe(200);
  const joined = joinRoomContract.response.parse(await response.json());
  expect(
    joined.room.players.find((player) => player.id === joined.membership.playerId)?.ready,
  ).toBe(false);
  await host.nextSnapshotWhere((snapshot) => snapshot.players.length === 2);
  const player = await authenticatedRoom(room.id, joined.membership.token);
  player.send({ type: "room.ready.set", ready: true });
  await host.nextSnapshotWhere((snapshot) =>
    snapshot.players.some((entry) => entry.id === joined.membership.playerId && entry.ready),
  );
  await joinRoom(room.id, "番号から参加");
  const socketResponse = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${room.id}/ws?instanceId=${room.instanceId}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(socketResponse.status).toBe(101);
  socketResponse.webSocket!.accept();
  socketResponse.webSocket!.close();
});

test("閉鎖・番号再利用後の古い招待は参加とWebSocket接続を拒否する", async () => {
  const { room, membership } = await createRoom();
  expect((await leaveRoom(room.id, membership.token)).status).toBe(204);
  const request = () =>
    new AcceptedGameRequest(`${baseUrl}/rooms/${room.id}/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "招待された人", instanceId: room.instanceId }),
    });
  expect((await exports.default.fetch(request())).status).toBe(404);
  const replacement = roomSchema.parse({
    ...room,
    instanceId: crypto.randomUUID(),
    lastActivityAtMs: Date.now(),
    players: [{ ...room.players[0], id: crypto.randomUUID(), reconnectDeadline: null }],
  });
  await env.GAME_ROOM.getByName(room.id).createRoom(replacement, "c".repeat(64));
  const before = await getRoom(room.id);
  const response = await exports.default.fetch(request());
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error: "room_changed" });
  const socketResponse = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${room.id}/ws?instanceId=${room.instanceId}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(socketResponse.status).toBe(410);
  expect(await socketResponse.json()).toEqual({ error: "room_changed" });
  expect((await getRoom(room.id)).players).toEqual(before.players);
});

test("招待の不正な識別子、参加前の満室化・開始を案内する", async () => {
  const setup = await startFourPlayerRoom();
  for (const instanceId of ["invalid", setup.room.instanceId]) {
    const response = await exports.default.fetch(
      new AcceptedGameRequest(`${baseUrl}/rooms/${setup.id}/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "招待された人", instanceId }),
      }),
    );
    expect(response.status).toBe(instanceId === "invalid" ? 400 : 409);
    expect(await response.json()).toEqual({
      error: instanceId === "invalid" ? "invalid_request" : "room_started",
    });
  }
  const full = await createRoom(true);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${full.room.id}/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "招待された人", instanceId: full.room.instanceId }),
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "room_full" });
  expect(
    (
      await exports.default.fetch(
        new AcceptedGameRequest(`${baseUrl}/rooms/${full.room.id}/ws?instanceId=invalid`, {
          headers: { Upgrade: "websocket" },
        }),
      )
    ).status,
  ).toBe(400);
});

async function joinRoom(id: string, name: string) {
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${joinRoomContract.pathFor(id)}`, {
      method: joinRoomContract.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(response.status).toBe(200);
  const result = joinRoomContract.response.parse(await response.json());
  return { ...result, room: roomSchema.parse(result.room) };
}

async function getRoom(id: string): Promise<Room> {
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(id)}`),
  );
  expect(response.status).toBe(200);
  return roomSchema.parse(getRoomContract.response.parse(await response.json()).room);
}

async function getMetadata(id: string): Promise<RoomPublicMetadata | null> {
  return env.GAME_ROOM.getByName(id).getPublicMetadata();
}

async function listRooms(cursor?: string) {
  const path = cursor
    ? `${listRoomsContract.path}?cursor=${encodeURIComponent(cursor)}`
    : listRoomsContract.path;
  const response = await exports.default.fetch(new AcceptedGameRequest(`${baseUrl}${path}`));
  expect(response.status).toBe(200);
  return listRoomsContract.response.parse(await response.json());
}

async function indexedRoom(id: string): Promise<{
  revision: number;
  closed: number;
  status: string;
  host_name: string | null;
  updated_at_ms: number;
} | null> {
  return env.APP_DB.prepare(
    "SELECT revision, closed, status, host_name, updated_at_ms FROM room_index WHERE room_id = ?",
  )
    .bind(id)
    .first();
}

async function waitForIndexedRoom(
  id: string,
  predicate: (row: NonNullable<Awaited<ReturnType<typeof indexedRoom>>>) => boolean,
) {
  await vi.waitFor(async () => {
    const row = await indexedRoom(id);
    expect(row !== null && predicate(row)).toBe(true);
  });
  return (await indexedRoom(id))!;
}

async function leaveRoom(id: string, token: string): Promise<Response> {
  return exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${leaveRoomContract.pathFor(id)}`, {
      method: leaveRoomContract.method,
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

async function getMembership(id: string, token: string): Promise<Response> {
  return exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomMembershipContract.pathFor(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

async function expectPending(id: string, playerId: string): Promise<void> {
  await vi.waitFor(async () => {
    const room = await getRoom(id);
    expect(typeof room.players.find((player) => player.id === playerId)?.reconnectDeadline).toBe(
      "number",
    );
  });
}

async function expirePlayers(id: string, playerIds: string[]): Promise<void> {
  const stub = env.GAME_ROOM.getByName(id);
  const deadline = Date.now() - 1;
  await runInDurableObject(stub, (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((player) =>
          playerIds.includes(player.id) ? { ...player, reconnectDeadline: deadline } : player,
        ),
      }),
    );
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

async function openRoom(id: string): Promise<RoomClient> {
  const response = await env.GAME_ROOM.getByName(id).fetch(
    new AcceptedGameRequest(`${baseUrl}${roomSocketContract.pathFor(id)}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("WebSocket upgrade failed");
  const client = new RoomClient(socket);
  clients.push(client);
  client.initialSnapshot = await client.nextType("room.snapshot");
  return client;
}

async function authenticatedRoom(id: string, token: string): Promise<RoomClient> {
  const client = await openRoom(id);
  client.send({ type: "room.auth", token });
  await client.nextType("room.authenticated");
  return client;
}

async function fourPlayers(timeControl?: RoomTimeControl) {
  const created = await createRoom(false, "singles", timeControl);
  const id = created.room.id;
  const participants = [created.membership];
  for (let index = 2; index <= 4; index++) {
    participants.push((await joinRoom(id, `参加者${index}`)).membership);
  }
  const connections = await Promise.all(
    participants.map((participant) => authenticatedRoom(id, participant.token)),
  );
  return { id, participants, connections };
}

async function readyPlayers(id: string, connections: RoomClient[]): Promise<void> {
  for (let index = 0; index < connections.length; index++) {
    connections[index].send({ type: "room.ready.set", ready: true });
    await connections[0].nextSnapshotWhere(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  expect((await getRoom(id)).players.every((player) => player.ready)).toBe(true);
}

async function startFourPlayerRoom() {
  const setup = await fourPlayers();
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  const room = await setup.connections[0].nextSnapshotWhere(
    (snapshot) => snapshot.status === "playing",
  );
  if (room.status !== "playing") throw new Error("Game did not start");
  return { ...setup, room };
}

async function setRoomDeadlines(
  id: string,
  change: (room: Extract<Room, { status: "playing" }>) => Room,
): Promise<void> {
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Game did not start");
    state.storage.kv.put("room", roomSchema.parse(change(room)));
  });
}

test.each(["resigned", "left", "timeout", "disconnected"] as const)(
  "脱落理由 %s を保存・配信し、再取得・途中観戦・旧データの復元で維持する",
  async (reason) => {
    const setup = await startFourPlayerRoom();
    const observer = await openRoom(setup.id);
    const black = setup.room.players.findIndex((player) => player.color === "black");
    const participant = setup.participants[black];
    if (reason === "resigned") setup.connections[black].send({ type: "room.game.resign" });
    else if (reason === "left") await leaveRoom(setup.id, participant.token);
    else if (reason === "disconnected") {
      setup.connections[black].close();
      await expectPending(setup.id, participant.playerId);
      expect((await getRoom(setup.id)).eliminations).toEqual([]);
      await expirePlayers(setup.id, [participant.playerId]);
    } else {
      await setRoomDeadlines(setup.id, (room) => ({
        ...room,
        clock: {
          ...room.clock,
          turnStartedAt: Date.now() - 330_001,
          turnExpiresAt: Date.now() - 1,
        },
      }));
      await runDurableObjectAlarm(env.GAME_ROOM.getByName(setup.id));
    }
    const expected = [{ color: "black", reason }];
    const snapshot = await observer.nextSnapshotWhere(
      (room) => room.status === "playing" && room.game.eliminatedColors.includes("black"),
    );
    expect(snapshot.eliminations).toEqual(expected);
    expect((await getRoom(setup.id)).eliminations).toEqual(expected);
    expect((await openRoom(setup.id)).initialSnapshot?.room.eliminations).toEqual(expected);
    await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_instance, state) => {
      const saved = state.storage.kv.get<Room>("room")!;
      expect(saved.eliminations).toEqual(expected);
      Reflect.deleteProperty(saved, "eliminations");
      state.storage.kv.put("room", saved);
    });
    expect((await getRoom(setup.id)).eliminations).toEqual(expected);
    expect((await openRoom(setup.id)).initialSnapshot?.room.eliminations).toEqual(expected);
    await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_instance, state) => {
      state.storage.kv.delete("round-replay");
    });
    const legacy = await getRoom(setup.id);
    expect(legacy.eliminations).toEqual([]);
    if (legacy.status !== "playing") throw new Error("Expected playing room");
    expect(legacy.game.eliminatedColors).toEqual(["black"]);
  },
);

test("投了・通信切れ・時間切れを順に記録し、終局後の再取得と観戦でも同じ棋譜を返す", async () => {
  const setup = await startFourPlayerRoom();
  const byColor = (color: string) =>
    setup.room.players.findIndex((player) => player.color === color);
  const observer = await openRoom(setup.id);
  setup.connections[byColor("black")].send({ type: "room.game.resign" });
  await observer.nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.turn === "white",
  );
  setup.connections[byColor("white")].close();
  const whiteId = setup.participants[byColor("white")].playerId;
  await expectPending(setup.id, whiteId);
  await expirePlayers(setup.id, [whiteId]);
  await observer.nextSnapshotWhere((room) => room.status === "playing" && room.game.turn === "red");
  await setRoomDeadlines(setup.id, (room) => ({
    ...room,
    clock: { ...room.clock, turnStartedAt: Date.now() - 330_001, turnExpiresAt: Date.now() - 1 },
  }));
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(setup.id));
  const ended = await observer.nextSnapshotWhere(
    (room) => room.status === "waiting" && room.lastRound !== null,
  );
  const replay = ended.lastRound?.replay;
  expect(replay?.steps.map((step) => step.action)).toEqual([
    { type: "eliminate", color: "black", reason: "resigned" },
    { type: "eliminate", color: "white", reason: "disconnected" },
    { type: "eliminate", color: "red", reason: "timeout" },
  ]);
  expect(replay?.steps.at(-1)?.game).toEqual(ended.lastRound?.game);
  expect((await getRoom(setup.id)).lastRound).toEqual(ended.lastRound);
  expect((await openRoom(setup.id)).initialSnapshot?.room.lastRound).toEqual(ended.lastRound);
});

test("未認証の接続はReadyを変更できない", async () => {
  const created = await createRoom();
  const client = await openRoom(created.room.id);
  client.send({ type: "room.ready.set", ready: true });

  expect((await client.nextType("room.error")).error).toBe("unauthorized");
  expect(await getRoom(created.room.id)).toEqual(created.room);
});

test("3人全員がReadyでも開始できない", async () => {
  const created = await createRoom();
  const id = created.room.id;
  const joined = await Promise.all([joinRoom(id, "参加者2"), joinRoom(id, "参加者3")]);
  const connections = await Promise.all(
    [created.membership, ...joined.map((entry) => entry.membership)].map((participant) =>
      authenticatedRoom(id, participant.token),
    ),
  );
  await readyPlayers(id, connections);
  const waiting = await getRoom(id);

  connections[0].send({ type: "room.game.start" });
  expect((await connections[0].nextType("room.error")).error).toBe("not_ready");
  expect(await getRoom(id)).toEqual(waiting);
});

test("4人全員がReadyのときだけホストが開始できる", async () => {
  const { id, connections } = await fourPlayers();
  for (let index = 0; index < 3; index++) {
    connections[index].send({ type: "room.ready.set", ready: true });
    await connections[0].nextSnapshotWhere(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  const waiting = await getRoom(id);
  connections[0].send({ type: "room.game.start" });
  expect((await connections[0].nextType("room.error")).error).toBe("not_ready");
  expect(await getRoom(id)).toEqual(waiting);

  connections[3].send({ type: "room.ready.set", ready: true });
  await connections[0].nextSnapshotWhere((room) => room.players.every((player) => player.ready));
  connections[3].send({ type: "room.ready.set", ready: true });
  await connections[3].nextSnapshotWhere((room) => room.players.every((player) => player.ready));
  connections[1].send({ type: "room.game.start" });
  expect((await connections[1].nextType("room.error")).error).toBe("forbidden");
  expect((await getRoom(id)).status).toBe("waiting");

  connections[0].send({ type: "room.game.start" });
  const started = await connections[1].nextSnapshotWhere((room) => room.status === "playing");
  expect(started.status).toBe("playing");
  expect(new Set(started.players.map((player) => player.color)).size).toBe(4);
  if (started.status === "playing") {
    expect(started.game.mode).toBe("singles");
    expect(started.game.turn).toBe("black");
    expect(started.game.moveNumber).toBe(0);
  }
  expect(await getRoom(id)).toEqual(started);
});

test("手番外と不正な着手は状態を変えず、合法手は保存・配信する", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");

  const blackIndex = started.players.findIndex((player) => player.color === "black");
  const otherIndex = started.players.findIndex((player) => player.color !== "black");
  expect(started.players[blackIndex].id).toBe(participants[blackIndex].playerId);
  const validMove = {
    type: "room.game.action",
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  } as const;

  connections[otherIndex].send(validMove);
  expect((await connections[otherIndex].nextType("room.error")).error).toBe("not_your_turn");
  expect(await getRoom(id)).toEqual(started);

  connections[blackIndex].send({
    type: "room.game.action",
    action: { type: "placeStone", position: { x: 3, y: 4 } },
  });
  expect((await connections[blackIndex].nextType("room.error")).error).toBe("invalid_move");
  expect(await getRoom(id)).toEqual(started);

  connections[blackIndex].send(validMove);
  const updated = await connections[otherIndex].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 1,
  );
  const senderView = await connections[blackIndex].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 1,
  );
  expect(senderView).toEqual(updated);
  expect(await getRoom(id)).toEqual(updated);
  if (updated.status === "playing") {
    expect(updated.game.lastMove).toEqual({ x: 2, y: 3 });
    expect(updated.game.board[3][2]).toBe("black");
    expect(updated.game.board[3][3]).toBe("black");
    expect(updated.game.turn).toBe("white");
  }
});

test("終局したルームを保存・配信し、以後の着手を拒否する", async () => {
  const { id, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  let room = await connections[0].nextSnapshotWhere((snapshot) => snapshot.status === "playing");

  for (let move = 0; move < 64 && room.status === "playing"; move++) {
    const turn = room.game.turn;
    const playerIndex = room.players.findIndex((player) => player.color === turn);
    const [position] = getLegalMoves(room.game);
    expect(playerIndex).toBeGreaterThanOrEqual(0);
    expect(position).toBeDefined();
    const previousMoveNumber = room.game.moveNumber;
    connections[playerIndex].send({
      type: "room.game.action",
      action: { type: "placeStone", position },
    });
    room = await connections[0].nextSnapshotWhere((snapshot) =>
      snapshot.status === "playing"
        ? snapshot.game.moveNumber > previousMoveNumber
        : (snapshot.lastRound?.game.moveNumber ?? 0) > previousMoveNumber,
    );
  }

  expect(room.status).toBe("waiting");
  if (room.status !== "waiting") return;
  expect(room.lastRound?.game.status).toBe("finished");
  expect(room.lastRound?.game.result.mode).toBe("singles");
  const replay = room.lastRound?.replay;
  expect(replay).toBeTruthy();
  if (!replay) throw new Error("Replay missing");
  let replayed = createInitialState("singles");
  expect(replay.initial).toEqual(replayed);
  for (const step of replay.steps) {
    if (step.action.type !== "place") throw new Error("Unexpected elimination");
    expect(step.action.color).toBe(replayed.turn);
    const applied = applyAction(replayed, { type: "placeStone", position: step.action.position });
    if (!applied.ok) throw new Error("Recorded move is invalid");
    expect(step.game).toEqual(applied.state);
    expect(step.passedColors).toEqual(applied.passedColors);
    replayed = applied.state;
  }
  expect(replay.steps.some((step) => step.passedColors.length > 0)).toBe(true);
  expect(replayed).toEqual(room.lastRound?.game);
  for (const connection of connections.slice(1)) {
    expect(
      await connection.nextSnapshotWhere(
        (snapshot) => snapshot.status === "waiting" && snapshot.lastRound !== null,
      ),
    ).toEqual(room);
  }
  expect(await getRoom(id)).toEqual(room);

  connections[0].send({
    type: "room.game.action",
    action: { type: "placeStone", position: { x: 0, y: 0 } },
  });
  expect((await connections[0].nextType("room.error")).error).toBe("game_finished");
  expect(await getRoom(id)).toEqual(room);
});

test("待機中の退室で席と資格を解放し、最古の参加者へホストを引き継ぐ", async () => {
  const created = await createRoom();
  const joined = await joinRoom(created.room.id, "次のホスト");
  const successor = await authenticatedRoom(created.room.id, joined.membership.token);

  expect((await leaveRoom(created.room.id, created.membership.token)).status).toBe(204);
  const room = await getRoom(created.room.id);
  expect(room.players.map((player) => player.id)).toEqual([joined.membership.playerId]);
  expect((await getMembership(created.room.id, created.membership.token)).status).toBe(401);
  expect(
    getRoomMembershipContract.response.parse(
      await (await getMembership(created.room.id, joined.membership.token)).json(),
    ).role,
  ).toBe("host");
  expect((await successor.nextType("room.authenticated")).membership.role).toBe("host");
});

test("待機中の最後の退室でルームを閉鎖する", async () => {
  const created = await createRoom();
  expect((await leaveRoom(created.room.id, created.membership.token)).status).toBe(204);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
  );
  expect(response.status).toBe(404);
});

test("接続が欠ける間は開始できず、30秒以内の復帰で同じ席を使う", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[3].close();
  await expectPending(id, participants[3].playerId);
  connections[0].send({ type: "room.game.start" });
  expect((await connections[0].nextType("room.error")).error).toBe("not_ready");

  await authenticatedRoom(id, participants[3].token);
  await vi.waitFor(async () => {
    const room = await getRoom(id);
    expect(room.players[3].reconnectDeadline).toBeNull();
    expect(room.players[3].ready).toBe(true);
  });
  connections[0].send({ type: "room.game.start" });
  expect((await connections[0].nextSnapshotWhere((room) => room.status === "playing")).status).toBe(
    "playing",
  );
});

test("同じ資格の別タブが接続中なら復帰期限を開始しない", async () => {
  const created = await createRoom();
  const first = await authenticatedRoom(created.room.id, created.membership.token);
  const second = await authenticatedRoom(created.room.id, created.membership.token);
  first.close();
  await vi.waitFor(async () => {
    expect((await getRoom(created.room.id)).players[0].reconnectDeadline).toBeNull();
  });
  second.close();
  await expectPending(created.room.id, created.membership.playerId);
});

test("切断通知を失っても次のアクセスで接続の欠落を検出する", async () => {
  const created = await createRoom();
  const client = await authenticatedRoom(created.room.id, created.membership.token);
  client.close();
  await expectPending(created.room.id, created.membership.playerId);
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((player) => ({ ...player, reconnectDeadline: null })),
      }),
    );
  });
  expect(typeof (await getRoom(created.room.id)).players[0].reconnectDeadline).toBe("number");
});

test("待機中の復帰期限切れで席を解放し、遅れたAlarmより先にGETで確定する", async () => {
  const created = await createRoom();
  const joined = await joinRoom(created.room.id, "参加者");
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  const participant = await authenticatedRoom(created.room.id, joined.membership.token);
  participant.close();
  await expectPending(created.room.id, joined.membership.playerId);
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((player) =>
          player.id === joined.membership.playerId
            ? { ...player, reconnectDeadline: Date.now() - 1 }
            : player,
        ),
      }),
    );
  });
  expect((await getRoom(created.room.id)).players.map((player) => player.id)).toEqual([
    created.membership.playerId,
  ]);
  expect((await getMembership(created.room.id, joined.membership.token)).status).toBe(401);
  expect((await host.nextSnapshotWhere((room) => room.players.length === 1)).players).toHaveLength(
    1,
  );
});

test("期限後の認証では待機中の席を復帰させず、最後の席なら閉鎖する", async () => {
  const created = await createRoom();
  const client = await authenticatedRoom(created.room.id, created.membership.token);
  client.close();
  await expectPending(created.room.id, created.membership.playerId);
  await expirePlayers(created.room.id, [created.membership.playerId]);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
  );
  expect(response.status).toBe(404);
  expect((await getMembership(created.room.id, created.membership.token)).status).toBe(404);
});

test("手番外の投了は拒否し、手番の投了は脱落と配信を行う", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  const black = started.players.findIndex((player) => player.color === "black");
  const other = started.players.findIndex((player) => player.color !== "black");
  connections[other].send({ type: "room.game.resign" });
  expect((await connections[other].nextType("room.error")).error).toBe("not_your_turn");
  expect(await getRoom(id)).toEqual(started);

  connections[black].send({ type: "room.game.resign" });
  const updated = await connections[other].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.eliminatedColors.includes("black"),
  );
  expect(updated.status).toBe("playing");
  expect(await getRoom(id)).toEqual(updated);
  expect((await getMembership(id, participants[black].token)).status).toBe(200);
  connections[black].send({ type: "room.game.resign" });
  expect((await connections[black].nextType("room.error")).error).toBe("already_eliminated");
});

test("対局中の退室は脱落させ、資格を失効する", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  const other = started.players.findIndex((player) => player.color !== "black");
  const color = started.players[other].color;
  expect((await leaveRoom(id, participants[other].token)).status).toBe(204);
  const updated = await getRoom(id);
  expect(updated.status).toBe("playing");
  if (updated.status === "playing") expect(updated.game.eliminatedColors).toContain(color);
  expect((await getMembership(id, participants[other].token)).status).toBe(401);
});

test("対局中の切断期限切れは脱落し、閲覧資格を残す", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  const black = started.players.findIndex((player) => player.color === "black");
  connections[black].close();
  await expectPending(id, participants[black].playerId);
  await expirePlayers(id, [participants[black].playerId]);
  const updated = await getRoom(id);
  expect(updated.status).toBe("playing");
  if (updated.status === "playing") expect(updated.game.eliminatedColors).toEqual(["black"]);
  expect((await getMembership(id, participants[black].token)).status).toBe(200);
  const returned = await authenticatedRoom(id, participants[black].token);
  returned.send({ type: "room.game.resign" });
  expect((await returned.nextType("room.error")).error).toBe("already_eliminated");
});

test("同時に期限切れになった対局者は入室順に脱落する", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  connections[1].close();
  connections[2].close();
  await expectPending(id, participants[1].playerId);
  await expectPending(id, participants[2].playerId);
  await expirePlayers(id, [participants[1].playerId, participants[2].playerId]);
  const updated = await getRoom(id);
  if (updated.status === "waiting") throw new Error("Game did not start");
  expect(updated.game.eliminatedColors).toEqual([
    started.players[1].color,
    started.players[2].color,
  ]);
});

test("開始・着手・再取得で時計の基準時刻と期限を維持する", async () => {
  const { id, connections, room } = await startFourPlayerRoom();
  expect(room.clock.remainingMainMs).toEqual({
    black: 300_000,
    white: 300_000,
    red: 300_000,
    blue: 300_000,
  });
  expect(room.clock.turnExpiresAt - room.clock.turnStartedAt).toBe(330_000);
  const fetched = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(id)}`),
  );
  const getPayload = getRoomContract.response.parse(await fetched.json());
  expect(getPayload.room).toEqual(room);
  expect(getPayload.serverNowMs).toBeGreaterThanOrEqual(room.clock.turnStartedAt);
  const reconnected = await openRoom(id);
  const snapshot = reconnected.initialSnapshot;
  if (snapshot === null) throw new Error("Room snapshot missing");
  expect(snapshot.room).toEqual(room);
  expect(snapshot.serverNowMs).toBeGreaterThanOrEqual(getPayload.serverNowMs);

  const black = room.players.findIndex((player) => player.color === "black");
  connections[black].send({
    type: "room.game.action",
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  });
  const moved = await connections[0].nextSnapshotWhere(
    (next) => next.status === "playing" && next.game.moveNumber === 1,
  );
  if (moved.status !== "playing") throw new Error("Game did not continue");
  expect(moved.clock.remainingMainMs.black).toBeLessThanOrEqual(300_000);
  expect(moved.clock.turnStartedAt).toBeGreaterThanOrEqual(room.clock.turnStartedAt);
  expect(moved.clock.turnExpiresAt - moved.clock.turnStartedAt).toBe(330_000);
  expect(await getRoom(id)).toEqual(moved);
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const replay = roundReplaySchema.parse(state.storage.kv.get("round-replay"));
    expect(replay.steps.at(-1)?.action).toMatchObject({ type: "place", color: "black" });
    if (moved.status === "playing") expect(replay.steps.at(-1)?.game).toEqual(moved.game);
  });
});

test("期限到達後の着手を拒否し、時間切れを全接続へ配信する", async () => {
  const { id, connections, participants, room } = await startFourPlayerRoom();
  const black = room.players.findIndex((player) => player.color === "black");
  await setRoomDeadlines(id, (current) => ({
    ...current,
    clock: {
      ...current.clock,
      remainingMainMs: { ...current.clock.remainingMainMs, black: 0 },
      turnStartedAt: Date.now() - 30_001,
      turnExpiresAt: Date.now() - 1,
    },
  }));
  connections[black].send({
    type: "room.game.action",
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  });
  const updated = await connections[0].nextSnapshotWhere(
    (next) => next.status !== "waiting" && next.game.eliminatedColors.includes("black"),
  );
  expect(updated.status).toBe("playing");
  if (updated.status !== "playing") throw new Error("Game ended too soon");
  expect(updated.game.moveNumber).toBe(0);
  expect(updated.game.turn).not.toBe("black");
  expect(updated.clock.remainingMainMs.black).toBe(0);
  expect(updated.clock.turnStartedAt).toBe(updated.clock.turnExpiresAt - 330_000);
  for (const connection of connections.slice(1)) {
    expect(
      await connection.nextSnapshotWhere(
        (next) => next.status !== "waiting" && next.game.eliminatedColors.includes("black"),
      ),
    ).toEqual(updated);
  }
  expect(await getRoom(id)).toEqual(updated);
  expect((await getMembership(id, participants[black].token)).status).toBe(200);
  expect((await connections[black].nextType("room.error")).error).toBe("already_eliminated");
});

test("同時刻の時計切れを復帰期限より先に処理する", async () => {
  const { id, connections, participants, room } = await startFourPlayerRoom();
  const other = room.players.findIndex((player) => player.color !== "black");
  connections[other].close();
  await expectPending(id, participants[other].playerId);
  const deadline = Date.now() - 1;
  await setRoomDeadlines(id, (current) => ({
    ...current,
    clock: {
      ...current.clock,
      remainingMainMs: { black: 0, white: 300_000, red: 300_000, blue: 300_000 },
      turnStartedAt: deadline - 30_000,
      turnExpiresAt: deadline,
    },
    players: current.players.map((player) =>
      player.kind === "human" && player.id === participants[other].playerId
        ? { ...player, reconnectDeadline: deadline }
        : player,
    ),
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const updated = await getRoom(id);
  if (updated.status === "waiting") throw new Error("Game did not start");
  expect(updated.game.eliminatedColors).toEqual(["black", room.players[other].color]);
});

test("復帰期限が時計より先なら、切断による脱落を先に処理する", async () => {
  const { id, connections, participants, room } = await startFourPlayerRoom();
  const other = room.players.findIndex((player) => player.color !== "black");
  connections[other].close();
  await expectPending(id, participants[other].playerId);
  const disconnectDeadline = Date.now() - 2;
  await setRoomDeadlines(id, (current) => ({
    ...current,
    clock: {
      ...current.clock,
      remainingMainMs: { ...current.clock.remainingMainMs, black: 0 },
      turnStartedAt: disconnectDeadline - 29_999,
      turnExpiresAt: disconnectDeadline + 1,
    },
    players: current.players.map((player) =>
      player.kind === "human" && player.id === participants[other].playerId
        ? { ...player, reconnectDeadline: disconnectDeadline }
        : player,
    ),
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const updated = await getRoom(id);
  if (updated.status === "waiting") throw new Error("Game did not start");
  expect(updated.game.eliminatedColors).toEqual([room.players[other].color, "black"]);
});

test("遅れたAlarmでも保存期限の順に連続時間切れを確定し、時計を止める", async () => {
  const { id, connections } = await startFourPlayerRoom();
  const deadline = Date.now() - 90_001;
  await setRoomDeadlines(id, (room) => ({
    ...room,
    clock: {
      remainingMainMs: { black: 0, white: 0, red: 0, blue: 0 },
      turnStartedAt: deadline - 30_000,
      turnExpiresAt: deadline,
    },
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const result = await getRoom(id);
  expect(result.status).toBe("waiting");
  if (result.status !== "waiting") throw new Error("Game did not finish");
  expect(result.lastRound?.game.eliminatedColors).toEqual(["black", "white", "red"]);
  expect(result.clock).toBeNull();
  for (const connection of connections) {
    expect(
      await connection.nextSnapshotWhere(
        (room) => room.status === "waiting" && room.lastRound !== null,
      ),
    ).toEqual(result);
  }
});

test("ホストだけが待機中のCPU席を追加・変更・削除できる", async () => {
  const created = await createRoom();
  const joined = await joinRoom(created.room.id, "参加者");
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  const participant = await authenticatedRoom(created.room.id, joined.membership.token);

  participant.send({ type: "room.cpu.add", level: 1 });
  expect((await participant.nextType("room.error")).error).toBe("forbidden");
  expect((await getRoom(created.room.id)).players).toHaveLength(2);

  host.send({ type: "room.cpu.add", level: 1 });
  const withCpu = await host.nextSnapshotWhere((room) => room.players.length === 3);
  const cpu = withCpu.players.find((player) => player.kind === "cpu");
  expect(cpu?.kind).toBe("cpu");
  if (cpu?.kind !== "cpu") throw new Error("CPU was not added");
  expect(cpu.level).toBe(1);
  expect(cpu.reconnectDeadline).toBeNull();
  host.send({ type: "room.cpu.level.set", playerId: cpu.id, level: 2 });
  const changed = await host.nextSnapshotWhere((room) =>
    room.players.some(
      (player) => player.id === cpu.id && player.kind === "cpu" && player.level === 2,
    ),
  );
  expect(changed.players.find((player) => player.id === cpu.id)?.kind).toBe("cpu");
  host.send({ type: "room.cpu.add", level: 1 });
  await host.nextSnapshotWhere((room) => room.players.length === 4);
  host.send({ type: "room.cpu.add", level: 1 });
  expect((await host.nextType("room.error")).error).toBe("room_full");
  host.send({ type: "room.cpu.remove", playerId: cpu.id });
  const removed = await host.nextSnapshotWhere((room) => room.players.length === 3);
  expect(removed.players.some((player) => player.id === cpu.id)).toBe(false);
  expect(await getRoom(created.room.id)).toEqual(removed);
});

test.each([
  roomTimeControl,
  { mainTimeMs: 0, byoyomiMs: 10_000 },
  { mainTimeMs: 60_000, byoyomiMs: 0 },
] as const)("すぐ遊ぶのCPU手番は $mainTimeMs + $byoyomiMs で保存・配信する", async (control) => {
  const created = await createRoom(true, "singles", control);
  const id = created.room.id;
  expect(created.room.players.filter((player) => player.kind === "human")).toHaveLength(1);
  expect(created.room.players.filter((player) => player.kind === "cpu")).toHaveLength(3);
  expect(created.room.players.every((player) => player.ready)).toBe(true);
  const host = await authenticatedRoom(id, created.membership.token);
  host.send({ type: "room.game.start" });
  let room = await host.nextSnapshotWhere((snapshot) => snapshot.status === "playing");
  if (room.status !== "playing") throw new Error("Game did not start");
  const openingTurn = room.game.turn;
  if (room.players.find((player) => player.color === openingTurn)?.kind === "human") {
    host.send({
      type: "room.game.action",
      action: { type: "placeStone", position: getLegalMoves(room.game)[0] },
    });
    room = await host.nextSnapshotWhere(
      (snapshot) => snapshot.status === "playing" && snapshot.game.moveNumber === 1,
    );
    if (room.status !== "playing") throw new Error("Game did not continue");
  }
  const cpuTurn = room.game.turn;
  expect(room.players.find((player) => player.color === cpuTurn)?.kind).toBe("cpu");
  const before = room.game.moveNumber;
  await setRoomDeadlines(id, (current) => ({
    ...current,
    clock: {
      ...current.clock,
      turnStartedAt: Date.now() - 2001,
      turnExpiresAt: Date.now() + control.mainTimeMs + control.byoyomiMs - 2001,
    },
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  await runInDurableObject(env.GAME_ROOM.getByName(id), async (_, state) => {
    const job = state.storage.kv.get<{ applyAt: number }>("four-reversi-cpu-job")!;
    state.storage.kv.put("four-reversi-cpu-job", { ...job, applyAt: Date.now() - 1 });
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const moved = await host.nextSnapshotWhere(
    (snapshot) => snapshot.status !== "waiting" && snapshot.game.moveNumber > before,
  );
  expect(moved.status).not.toBe("waiting");
  if (moved.status === "playing") {
    expect(moved.clock.turnExpiresAt - moved.clock.turnStartedAt).toBe(
      moved.clock.remainingMainMs[moved.game.turn] + control.byoyomiMs,
    );
  }
  expect(await getRoom(id)).toEqual(moved);
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const replay = roundReplaySchema.parse(state.storage.kv.get("round-replay"));
    expect(replay.steps.at(-1)?.action).toMatchObject({ type: "place", color: cpuTurn });
    if (moved.status === "playing") expect(replay.steps.at(-1)?.game).toEqual(moved.game);
  });
});

test("ルーム作成のモードは必須で、すぐ遊ぶにも選択したモードを保存する", async () => {
  for (const body of [
    { name: "ホスト", quickPlay: false },
    { name: "ホスト", quickPlay: false, mode: "other" },
  ]) {
    const response = await exports.default.fetch(
      new AcceptedGameRequest(`${baseUrl}${createRoomContract.path}`, {
        method: createRoomContract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({ error: "invalid_request" });
  }

  const singles = await createRoom(false, "singles");
  const doubles = await createRoom(true, "doubles");
  expect(singles.room.settings).toEqual({
    game: "four-reversi",
    mode: "singles",
    timeControl: roomTimeControl,
  });
  expect(singles.room.players).toHaveLength(1);
  expect(doubles.room.settings.mode).toBe("doubles");
  expect(doubles.room.players.filter((player) => player.kind === "cpu")).toHaveLength(3);
  expect(doubles.room.players.every((player) => player.ready)).toBe(true);
});

test("待機中のモード変更はホストのみ可能で、人間のReadyを解除する", async () => {
  const created = await createRoom();
  const joined = await joinRoom(created.room.id, "二人目");
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  const guest = await authenticatedRoom(created.room.id, joined.membership.token);
  host.send({ type: "room.ready.set", ready: true });
  await host.nextSnapshotWhere((room) => room.players[0].ready);
  guest.send({ type: "room.ready.set", ready: true });
  await host.nextSnapshotWhere((room) => room.players[1].ready);

  guest.send({ type: "room.mode.set", mode: "doubles" });
  expect((await guest.nextType("room.error")).error).toBe("forbidden");
  const before = await getMetadata(created.room.id);
  host.send({ type: "room.mode.set", mode: "doubles" });
  const changed = await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  expect(changed.players.filter((player) => player.kind === "human" && player.ready)).toHaveLength(
    0,
  );
  expect((await getMetadata(created.room.id))?.updatedAtMs).toBeGreaterThan(before!.updatedAtMs);
  expect((await getRoom(created.room.id)).settings.mode).toBe("doubles");

  const updatedAtMs = (await getMetadata(created.room.id))!.updatedAtMs;
  host.send({ type: "room.mode.set", mode: "doubles" });
  await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  expect((await getMetadata(created.room.id))?.updatedAtMs).toBe(updatedAtMs);
});

test("すぐ遊ぶのモード変更ではCPUだけがReadyを維持する", async () => {
  const created = await createRoom(true);
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.mode.set", mode: "doubles" });
  const changed = await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  expect(changed.players.filter((player) => player.kind === "human" && player.ready)).toHaveLength(
    0,
  );
  expect(changed.players.filter((player) => player.kind === "cpu" && player.ready)).toHaveLength(3);
});

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

test("チャットは認証・文字数・間隔を検証し、直近100件を再接続先へ送る", async () => {
  const created = await createRoom();
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  const spectator = await openRoom(created.room.id);
  spectator.send({ type: "room.chat.send", text: "観戦者" });
  expect((await spectator.nextType("room.error")).error).toBe("unauthorized");
  host.send({ type: "room.chat.send", text: "最初" });
  expect(
    (await spectator.nextChatWhere((messages) => messages.at(-1)?.text === "最初")).at(-1)?.text,
  ).toBe("最初");
  host.send({ type: "room.chat.send", text: "連投" });
  expect((await host.nextType("room.chat.error")).error).toBe("rate_limited");
  host.send({ type: "room.chat.send", text: "https://example.com" });
  expect((await host.nextType("room.chat.error")).error).toBe("invalid_request");
  host.send({ type: "room.chat.send", text: "あ".repeat(101) });
  expect((await host.nextType("room.chat.error")).error).toBe("invalid_request");
  for (let index = 1; index <= 100; index++) {
    await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), (_instance, state) => {
      state.storage.kv.put(`last-chat-at:${created.membership.playerId}`, Date.now() - 3_001);
    });
    host.send({ type: "room.chat.send", text: `投稿${index}` });
    await spectator.nextChatWhere((messages) => messages.at(-1)?.text === `投稿${index}`);
  }
  const reloaded = await openRoom(created.room.id);
  const history = await reloaded.nextChatWhere((messages) => messages.length === 100);
  expect(history[0].text).toBe("投稿1");
  expect(history.at(-1)?.text).toBe("投稿100");
  expect((await getRoom(created.room.id)).status).toBe("waiting");
});

test("観戦者は匿名資格で通報し、運営者が削除・送信停止できる", async () => {
  const created = await createRoom();
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.chat.send", text: "確認対象" });
  const message = (await host.nextChatWhere((messages) => messages.at(-1)?.text === "確認対象")).at(
    -1,
  )!;
  const viewerResponse = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${viewerContract.pathFor(created.room.id)}`, {
      method: "POST",
    }),
  );
  expect(viewerResponse.status).toBe(201);
  const viewer = viewerContract.response.parse(await viewerResponse.json());
  const reportRequest = () =>
    new AcceptedGameRequest(`${baseUrl}${reportContract.pathFor(created.room.id)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: message.id }),
    });
  const reported = await exports.default.fetch(reportRequest());
  expect(reported.status).toBe(201);
  const reportId = reportContract.response.parse(await reported.json()).id;
  expect((await exports.default.fetch(reportRequest())).status).toBe(409);
  const unauthorized = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${listReportsContract.path}`),
  );
  expect(unauthorized.status).toBe(401);
  const auth = { Authorization: "Bearer test-moderator-token" };
  const listing = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${listReportsContract.path}`, { headers: auth }),
  );
  expect(listing.status).toBe(200);
  expect(
    listReportsContract.response
      .parse(await listing.json())
      .reports.some((report) => report.id === reportId),
  ).toBe(true);
  const action = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${moderateReportContract.pathFor(reportId)}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_and_mute" }),
    }),
  );
  expect(action.status).toBe(200);
  expect(moderateReportContract.response.parse(await action.json()).status).toBe("resolved");
  expect(
    (
      await host.nextChatWhere((messages) => messages.every((entry) => entry.kind === "system"))
    ).every((entry) => entry.kind === "system"),
  ).toBe(true);
  host.send({ type: "room.chat.send", text: "再投稿" });
  expect((await host.nextType("room.chat.error")).error).toBe("muted");
});

test("通報D1障害は成功扱いにせず、期限切れ通報を定期削除する", async () => {
  const created = await createRoom();
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.chat.send", text: "通報対象" });
  const message = (await host.nextChatWhere((messages) => messages.at(-1)?.text === "通報対象")).at(
    -1,
  )!;
  const request = () =>
    new AcceptedGameRequest(`${baseUrl}${reportContract.pathFor(created.room.id)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.membership.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: message.id }),
    });
  await env.APP_DB.exec("ALTER TABLE reports RENAME TO reports_unavailable");
  try {
    expect((await exports.default.fetch(request())).status).toBe(500);
  } finally {
    await env.APP_DB.exec("ALTER TABLE reports_unavailable RENAME TO reports");
  }
  const response = await exports.default.fetch(request());
  expect(response.status).toBe(201);
  const id = reportContract.response.parse(await response.json()).id;
  await env.APP_DB.prepare("UPDATE reports SET expires_at_ms = ? WHERE id = ?")
    .bind(Date.now() - 1, id)
    .run();
  const listing = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${listReportsContract.path}`, {
      headers: { Authorization: "Bearer test-moderator-token" },
    }),
  );
  expect(
    listReportsContract.response
      .parse(await listing.json())
      .reports.some((entry) => entry.id === id),
  ).toBe(false);
  await worker.scheduled({} as ScheduledController, env);
  expect(
    await env.APP_DB.prepare("SELECT id FROM reports WHERE id = ?").bind(id).first(),
  ).toBeNull();
});

test("24時間の活動停止でルームを閉鎖し、索引から除外する", async () => {
  const created = await createRoom();
  const stub = env.GAME_ROOM.getByName(created.room.id);
  await runInDurableObject(stub, (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({ ...room, lastActivityAtMs: Date.now() - 24 * 60 * 60 * 1000 - 1 }),
    );
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(
    (
      await exports.default.fetch(
        new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
      )
    ).status,
  ).toBe(404);
  await waitForIndexedRoom(created.room.id, (row) => row.closed === 1);
});

test("対局終了時に人間が残っていなければ部屋を閉鎖する", async () => {
  const created = await createRoom(true, "doubles");
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.game.start" });
  await host.nextSnapshotWhere((room) => room.status === "playing");
  expect((await leaveRoom(created.room.id, created.membership.token)).status).toBe(204);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
  );
  expect(response.status).toBe(404);
  await waitForIndexedRoom(created.room.id, (row) => row.closed === 1);
});

test("終局後は自動で再戦待機になり、ホストを引き継いで次局を開始できる", async () => {
  const setup = await fourPlayers();
  setup.connections[0].send({ type: "room.mode.set", mode: "doubles" });
  await setup.connections[0].nextSnapshotWhere((room) => room.settings.mode === "doubles");
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  expect((await leaveRoom(setup.id, setup.participants[0].token)).status).toBe(204);
  const waiting = await setup.connections[1].nextSnapshotWhere(
    (room) => room.status === "waiting" && room.lastRound !== null,
  );
  if (waiting.status !== "waiting") throw new Error("Rematch waiting state missing");
  expect(waiting.players).toHaveLength(3);
  expect(waiting.players.every((player) => player.kind === "cpu" || !player.ready)).toBe(true);
  expect(waiting.lastRound?.players).toHaveLength(4);
  expect(waiting.lastRound?.replay?.steps.at(-1)?.action).toMatchObject({
    type: "eliminate",
    reason: "left",
  });
  const promoted = getRoomMembershipContract.response.parse(
    await (await getMembership(setup.id, setup.participants[1].token)).json(),
  );
  expect(promoted.role).toBe("host");
  setup.connections[1].send({ type: "room.cpu.add", level: 1 });
  await setup.connections[1].nextSnapshotWhere(
    (room) => room.players.length === 4 && room.status === "waiting",
  );
  for (const connection of setup.connections.slice(1))
    connection.send({ type: "room.ready.set", ready: true });
  await setup.connections[1].nextSnapshotWhere((room) =>
    room.players.every((player) => player.ready),
  );
  setup.connections[1].send({ type: "room.game.start" });
  const restarted = await setup.connections[1].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 0,
  );
  expect(restarted.lastRound).toBeNull();
  expect(waiting.eliminations).toEqual([]);
  expect(restarted.eliminations).toEqual([]);
  await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_instance, state) => {
    const replay = roundReplaySchema.parse(state.storage.kv.get("round-replay"));
    expect(replay.id).not.toBe(waiting.lastRound?.replay?.id);
    expect(replay.steps).toEqual([]);
  });
  expect(new Set(restarted.players.map((player) => player.color)).size).toBe(4);
});

test("再戦では切断からの元の30秒期限を引き継ぐ", async () => {
  const setup = await fourPlayers();
  setup.connections[0].send({ type: "room.mode.set", mode: "doubles" });
  await setup.connections[0].nextSnapshotWhere((room) => room.settings.mode === "doubles");
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  setup.connections[3].close();
  await vi.waitFor(async () => {
    expect(
      (await getRoom(setup.id)).players.find(
        (player) => player.id === setup.participants[3].playerId,
      )?.reconnectDeadline,
    ).not.toBeNull();
  });
  const deadline = (await getRoom(setup.id)).players.find(
    (player) => player.id === setup.participants[3].playerId,
  )?.reconnectDeadline;
  expect((await leaveRoom(setup.id, setup.participants[1].token)).status).toBe(204);
  const waiting = await getRoom(setup.id);
  expect(waiting.status).toBe("waiting");
  expect(
    waiting.players.find((player) => player.id === setup.participants[3].playerId)
      ?.reconnectDeadline,
  ).toBe(deadline);
  await expirePlayers(setup.id, [setup.participants[3].playerId]);
  expect(
    (await getRoom(setup.id)).players.some(
      (player) => player.id === setup.participants[3].playerId,
    ),
  ).toBe(false);
});

test("通報済みの旧世代へ処分しても再利用された部屋を変更しない", async () => {
  const created = await createRoom();
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.chat.send", text: "旧ルーム" });
  const message = (await host.nextChatWhere((messages) => messages.at(-1)?.text === "旧ルーム")).at(
    -1,
  )!;
  const report = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${reportContract.pathFor(created.room.id)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.membership.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: message.id }),
    }),
  );
  expect(report.status).toBe(201);
  const reportId = reportContract.response.parse(await report.json()).id;
  expect((await leaveRoom(created.room.id, created.membership.token)).status).toBe(204);
  const replacement = roomSchema.parse({
    ...created.room,
    instanceId: crypto.randomUUID(),
    lastActivityAtMs: Date.now(),
    players: [{ ...created.room.players[0], id: crypto.randomUUID(), reconnectDeadline: null }],
  });
  expect(
    await env.GAME_ROOM.getByName(created.room.id).createRoom(replacement, "b".repeat(64)),
  ).not.toBeNull();
  const action = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${moderateReportContract.pathFor(reportId)}`, {
      method: "POST",
      headers: { Authorization: "Bearer test-moderator-token", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_and_mute" }),
    }),
  );
  expect(action.status).toBe(409);
  expect((await getRoom(created.room.id)).instanceId).toBe(replacement.instanceId);
});

test("時間設定は待機中のホストだけが変更でき、準備解除・配信・永続化・公開索引へ反映する", async () => {
  const setup = await fourPlayers();
  await readyPlayers(setup.id, setup.connections);
  const host = setup.connections[0];
  const observer = await openRoom(setup.id);
  const control = { mainTimeMs: 60_000, byoyomiMs: 10_000 } as const;
  setup.connections[1].send({ type: "room.time-control.set", timeControl: control });
  expect((await setup.connections[1].nextType("room.error")).error).toBe("forbidden");
  observer.send({ type: "room.time-control.set", timeControl: control });
  expect((await observer.nextType("room.error")).error).toBe("unauthorized");
  host.sendRaw({ type: "room.time-control.set", timeControl: { mainTimeMs: 0, byoyomiMs: 0 } });
  expect((await host.nextType("room.error")).error).toBe("invalid_request");
  host.send({ type: "room.time-control.set", timeControl: control });
  const updated = await host.nextSnapshotWhere(
    (room) => room.settings.timeControl.mainTimeMs === 60_000,
  );
  expect(updated.players.every((player) => !player.ready)).toBe(true);
  expect(
    (await observer.nextSnapshotWhere((room) => room.settings.timeControl.mainTimeMs === 60_000))
      .settings.timeControl,
  ).toEqual(control);
  expect((await getRoom(setup.id)).settings.timeControl).toEqual(control);
  await vi.waitFor(async () => {
    let page = await listRooms();
    let metadata = page.rooms.find((room) => room.id === setup.id);
    while (!metadata && page.nextCursor) {
      page = await listRooms(page.nextCursor);
      metadata = page.rooms.find((room) => room.id === setup.id);
    }
    expect(metadata?.timeControl).toEqual(control);
  });
  expect((await openRoom(setup.id)).initialSnapshot?.room.settings.timeControl).toEqual(control);
  await readyPlayers(setup.id, setup.connections);
  const ready = await getRoom(setup.id);
  host.send({ type: "room.time-control.set", timeControl: control });
  const unchanged = await host.nextSnapshotWhere((room) =>
    room.players.every((player) => player.ready),
  );
  expect(unchanged.publicUpdatedAtMs).toBe(ready.publicUpdatedAtMs);
  expect(unchanged.lastActivityAtMs).toBe(ready.lastActivityAtMs);
  host.send({ type: "room.game.start" });
  const started = await host.nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Not playing");
  expect(started.clock.turnExpiresAt - started.clock.turnStartedAt).toBe(70_000);
  host.send({ type: "room.time-control.set", timeControl: roomTimeControl });
  expect((await host.nextType("room.error")).error).toBe("already_started");
});

test.each([
  { mainTimeMs: 0, byoyomiMs: 10_000 },
  { mainTimeMs: 60_000, byoyomiMs: 0 },
  { mainTimeMs: 180_000, byoyomiMs: 30_000 },
] as const)("リバーシの着手・時間切れ・再戦は $mainTimeMs + $byoyomiMs を使う", async (control) => {
  const setup = await fourPlayers(control);
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  let room = await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (room.status !== "playing") throw new Error("Not playing");
  expect(room.clock.turnExpiresAt - room.clock.turnStartedAt).toBe(
    control.mainTimeMs + control.byoyomiMs,
  );
  const black = room.players.findIndex((p) => p.color === "black");
  setup.connections[black].send({
    type: "room.game.action",
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  });
  room = await setup.connections[0].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 1,
  );
  if (room.status !== "playing") throw new Error("Not playing");
  expect(room.clock.turnExpiresAt - room.clock.turnStartedAt).toBe(
    control.mainTimeMs + control.byoyomiMs,
  );
  const turn = room.game.turn;
  const turnIndex = room.players.findIndex((p) => p.color === turn);
  await setRoomDeadlines(setup.id, (current) => ({
    ...current,
    clock: { ...current.clock, turnExpiresAt: Date.now() },
  }));
  setup.connections[turnIndex].send({
    type: "room.game.action",
    action: { type: "placeStone", position: getLegalMoves(room.game)[0] },
  });
  expect((await setup.connections[turnIndex].nextType("room.error")).error).toBe(
    "already_eliminated",
  );
  const expired = await setup.connections[0].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.eliminatedColors.includes(turn),
  );
  if (expired.status !== "playing") throw new Error("Not playing");
  expect(
    expired.eliminations.some((entry) => entry.color === turn && entry.reason === "timeout"),
  ).toBe(true);
  room = expired;
  while (room.status === "playing") {
    const currentTurn = room.game.turn;
    const index = room.players.findIndex((p) => p.color === currentTurn);
    const eliminated = room.game.eliminatedColors.length;
    setup.connections[index].send({ type: "room.game.resign" });
    room = await setup.connections[0].nextSnapshotWhere(
      (room) => room.status === "waiting" || room.game.eliminatedColors.length > eliminated,
    );
  }
  expect(room.settings.timeControl).toEqual(control);
  const lastRound = room.lastRound;
  const matchId = lastRound!.replay!.id;
  setup.connections[0].send({ type: "room.time-control.set", timeControl: roomTimeControl });
  const changed = await setup.connections[0].nextSnapshotWhere(
    (room) => room.settings.timeControl.mainTimeMs === 300_000,
  );
  expect(changed.lastRound).toEqual(lastRound);
  await vi.waitFor(async () => {
    const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(matchId)
      .first<{ record_json: string }>();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.record_json).settings.timeControl).toEqual(control);
  });
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  const rematch = await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (rematch.status !== "playing") throw new Error("Not playing");
  expect(rematch.clock.turnExpiresAt - rematch.clock.turnStartedAt).toBe(330_000);
});
