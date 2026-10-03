import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  getLegalActions,
  sides,
  type Side,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  createRoomContract,
  joinRoomContract,
  getRoomContract,
  getFourShogiReplayContract,
  listRoomsContract,
  roomSocketContract,
  fourShogiRoomSchema,
  isFourShogiRoom,
  type FourShogiRoom,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { ShogiStore } from "../src/rooms/shogiStore";
import {
  pendingShogiMatchPrefix,
  readShogiMatchRecord,
  shogiMatchStartKey,
  type ActiveShogiMatch,
  type PendingShogiMatch,
} from "../src/rooms/shogiMatchStore";
import { accountFixture, origin } from "./accountFixtures";

const base = "https://example.com";
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(base + path, init));
const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const sockets: ShogiClient[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});
class ShogiClient {
  private messages: RoomSocketMessage[] = [];
  private receivers: ((message: RoomSocketMessage) => void)[] = [];
  constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = roomSocketContract.message.parse(JSON.parse(String(event.data)));
      const receiver = this.receivers.shift();
      if (receiver) receiver(message);
      else this.messages.push(message);
    });
    socket.accept();
    sockets.push(this);
  }
  send(message: RoomSocketClientMessage) {
    this.socket.send(JSON.stringify(message));
  }
  close() {
    this.socket.close();
  }
  private next(): Promise<RoomSocketMessage> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const receiver = (message: RoomSocketMessage) => {
        clearTimeout(timeout);
        resolve(message);
      };
      const timeout = setTimeout(() => {
        this.receivers = this.receivers.filter((entry) => entry !== receiver);
        reject(new Error("Shogi socket timed out"));
      }, 5000);
      this.receivers.push(receiver);
    });
  }
  async until(predicate: (message: RoomSocketMessage) => boolean) {
    for (;;) {
      const message = await this.next();
      if (predicate(message)) return message;
    }
  }
  async room(predicate: (room: FourShogiRoom) => boolean) {
    const message = await this.until(
      (message) =>
        message.type === "room.snapshot" &&
        isFourShogiRoom(message.room) &&
        predicate(message.room),
    );
    if (message.type !== "room.snapshot") throw new Error("No snapshot");
    return fourShogiRoomSchema.parse(message.room);
  }
  async error() {
    const message = await this.until((message) => message.type === "room.error");
    if (message.type !== "room.error") throw new Error("No error");
    return message.error;
  }
}
async function connect(id: string, token?: string) {
  const response = await request(`/rooms/${id}/ws`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = new ShogiClient(response.webSocket!);
  if (token) {
    socket.send({ type: "room.auth", token });
    await socket.until((message) => message.type === "room.authenticated");
  }
  return socket;
}
async function create(quickPlay = false, mode: "singles" | "doubles" = "singles") {
  const response = await request(
    "/rooms",
    json({ name: "将棋ホスト", game: "four-shogi", quickPlay, mode }),
  );
  expect(response.status).toBe(201);
  const entry = createRoomContract.response.parse(await response.json());
  return { ...entry, room: fourShogiRoomSchema.parse(entry.room) };
}
async function get(id: string) {
  const response = await request(`/rooms/${id}`);
  expect(response.status).toBe(200);
  return fourShogiRoomSchema.parse(getRoomContract.response.parse(await response.json()).room);
}
async function setup(mode: "singles" | "doubles" = "singles") {
  const created = await create(false, mode);
  const memberships = [created.membership];
  for (let index = 1; index < 4; index++) {
    const response = await request(
      `/rooms/${created.room.id}/players`,
      json({ name: `将棋${index}` }),
    );
    expect(response.status).toBe(200);
    memberships.push(joinRoomContract.response.parse(await response.json()).membership);
  }
  const clients = await Promise.all(
    memberships.map((member) => connect(created.room.id, member.token)),
  );
  for (let index = 0; index < 4; index++) {
    clients[index].send({ type: "room.ready.set", ready: true });
    await clients[0].room(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  return { id: created.room.id, memberships, clients };
}
async function start(mode: "singles" | "doubles" = "singles") {
  const prepared = await setup(mode);
  prepared.clients[0].send({ type: "room.game.start" });
  const room = await prepared.clients[0].room((room) => room.status === "playing");
  if (room.status !== "playing") throw new Error("Not playing");
  return { ...prepared, room };
}
function sideIndex(setup: Awaited<ReturnType<typeof start>>, side: Side) {
  return setup.room.players.findIndex((player) => player.side === side);
}
async function resignCurrent(setup: Awaited<ReturnType<typeof start>>, room: FourShogiRoom) {
  if (room.status !== "playing") throw new Error("Not playing");
  const index = sideIndex(setup, room.game.turn);
  setup.clients[index].send({ type: "room.game.resign" });
  return setup.clients[0].room(
    (next) => next.status === "waiting" || next.positionRevision > room.positionRevision,
  );
}

test("ゲーム指定省略は旧リバーシ形式、将棋の作成・参加・一覧は独立する", async () => {
  const reversiResponse = await request(
    "/rooms",
    json({ name: "旧形式", quickPlay: false, mode: "singles" }),
  );
  expect(reversiResponse.status).toBe(201);
  const reversi = createRoomContract.response.parse(await reversiResponse.json()).room;
  expect(reversi.settings.game).toBe("four-reversi");
  expect(reversi.players[0]).toHaveProperty("color", null);
  expect(reversi).not.toHaveProperty("roundId");
  const shogi = await create();
  expect(shogi.room.settings.threePlayerAttackProhibited).toBe(true);
  expect(shogi.room.players[0]).toHaveProperty("side", null);
  expect(shogi.room.players[0]).not.toHaveProperty("color");
  const joined = await request(
    `/rooms/${shogi.room.id}/players`,
    json({ name: "将棋参加者", instanceId: shogi.room.instanceId }),
  );
  expect(joined.status).toBe(200);
  expect(
    fourShogiRoomSchema.parse(joinRoomContract.response.parse(await joined.json()).room).players,
  ).toHaveLength(2);
  await request(`/rooms/${reversi.id}`);
  await get(shogi.room.id);
  const list = async (game?: string) => {
    const rooms: import("@tetraboard/protocol").RoomPublicMetadata[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams();
      if (game) query.set("game", game);
      if (cursor) query.set("cursor", cursor);
      const page = listRoomsContract.response.parse(
        await (await request(`/rooms?${query}`)).json(),
      );
      rooms.push(...page.rooms);
      cursor = page.nextCursor;
    } while (cursor);
    return rooms;
  };
  expect((await list()).some((room) => room.id === reversi.id)).toBe(true);
  expect((await list()).some((room) => room.id === shogi.room.id)).toBe(false);
  expect((await list("four-shogi")).some((room) => room.id === shogi.room.id)).toBe(true);
  expect((await list("four-shogi")).every((room) => room.game === "four-shogi")).toBe(true);
});

test("将棋設定は待機中のホストのみ、CPU設定と準備・担当方向・観戦を配信する", async () => {
  const prepared = await setup();
  prepared.clients[1].send({ type: "room.three-player-attack.set", prohibited: false });
  expect(await prepared.clients[1].error()).toBe("forbidden");
  prepared.clients[0].send({ type: "room.three-player-attack.set", prohibited: false });
  let waiting = await prepared.clients[0].room(
    (room) => !room.settings.threePlayerAttackProhibited,
  );
  expect(waiting.players.every((player) => !player.ready)).toBe(true);
  for (let index = 0; index < 4; index++) {
    prepared.clients[index].send({ type: "room.ready.set", ready: true });
    await prepared.clients[0].room(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  prepared.clients[0].send({ type: "room.game.start" });
  const room = await prepared.clients[0].room((room) => room.status === "playing");
  if (room.status !== "playing") throw new Error("Not playing");
  expect(new Set(room.players.map((player) => player.side))).toEqual(new Set(sides));
  expect(room.game.turn).toBe("south");
  expect(room.game.board.flat().filter(Boolean)).toHaveLength(36);
  expect(room.game.threePlayerAttackProhibited).toBe(false);
  expect(room.legalActions.length).toBeGreaterThan(0);
  expect(room.checkState).toEqual({ south: false, west: false, north: false, east: false });
  expect(room.game).not.toHaveProperty("repetitions");
  prepared.clients[0].send({ type: "room.three-player-attack.set", prohibited: true });
  expect(await prepared.clients[0].error()).toBe("already_started");
  const observer = await connect(prepared.id);
  const snapshot = await observer.room((room) => room.status === "playing");
  expect(snapshot).toEqual(room);
});

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

test("投了は本人手番だけで順位を保存し、直前棋譜と恒久棋譜を保存する", async () => {
  const prepared = await start();
  prepared.clients[sideIndex(prepared, "west")].send({ type: "room.game.resign" });
  expect(await prepared.clients[sideIndex(prepared, "west")].error()).toBe("not_your_turn");
  let room: FourShogiRoom = prepared.room;
  for (let index = 0; index < 3; index++) room = await resignCurrent(prepared, room);
  if (room.status !== "waiting" || !room.lastRound) throw new Error("No result");
  expect(room.lastRound.game.result).toMatchObject({
    mode: "singles",
    reason: "last_player",
    standings: [
      { side: "east", rank: 1 },
      { side: "north", rank: 2 },
      { side: "west", rank: 3 },
      { side: "south", rank: 4 },
    ],
  });
  expect(room.lastRound.eventCount).toBe(3);
  expect(room.lastRound).not.toHaveProperty("replay");
  expect(room.lastRound.game).not.toHaveProperty("repetitions");
  const url = getFourShogiReplayContract.pathFor(prepared.id, room.lastRound.roundId);
  const response = await request(`${url}?instanceId=${room.instanceId}`);
  expect(response.status).toBe(200);
  const replay = getFourShogiReplayContract.response.parse(await response.json());
  expect(replay.events.map((entry) => entry.event)).toEqual(
    ["south", "west", "north"].map((side) => ({ type: "eliminate", side, reason: "resigned" })),
  );
  expect(replay.nextCursor).toBeNull();
  let reconstructed = createInitialState(replay.initial);
  for (const { event } of replay.events) {
    const next =
      event.type === "action"
        ? applyAction(reconstructed, event.side, event.action)
        : eliminateSide(reconstructed, event.side, event.reason);
    if (!next.ok) throw new Error("Replay failed");
    reconstructed = next.state;
  }
  const { repetitions: _index, ...core } = reconstructed;
  expect(core).toEqual(room.lastRound.game);
  expect((await request(`${url}?instanceId=${crypto.randomUUID()}`)).status).toBe(410);
  expect((await request(`${url}?instanceId=${room.instanceId}&cursor=4`)).status).toBe(404);
  const matchId = room.lastRound.roundId;
  await vi.waitFor(async () => {
    expect(
      (await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(matchId).all()).results,
    ).toHaveLength(1);
  });
  expect(await get(prepared.id)).toEqual(room);
});

test("ダブルスの手番外退出はチーム敗北と待機への遷移を配信する", async () => {
  const prepared = await start("doubles");
  const index = sideIndex(prepared, "east");
  const response = await request(`/rooms/${prepared.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${prepared.memberships[index].token}` },
  });
  expect(response.status).toBe(204);
  const room = await prepared.clients[0].room((room) => room.status === "waiting");
  expect(room.lastRound?.game.result).toEqual({
    mode: "doubles",
    reason: "team_eliminated",
    winner: "south-north",
  });
  expect(room.lastRound?.game.eliminations).toMatchObject([
    { side: "east", reason: "left", rank: null },
  ]);
  expect(room.players).toHaveLength(3);
});

test("接続復帰は期限を解除し、通信期限切れと時計期限はサーバーで脱落処理する", async () => {
  const prepared = await start();
  const index = sideIndex(prepared, "east");
  prepared.clients[index].close();
  const disconnected = await prepared.clients[(index + 1) % 4].room(
    (room) => room.status === "playing" && room.players[index].reconnectDeadline !== null,
  );
  expect(disconnected.players[index].reconnectDeadline).not.toBeNull();
  // eastがホストでも、以降の投了確認は復帰した接続で受信します。
  prepared.clients[index] = await connect(prepared.id, prepared.memberships[index].token);
  const restored = await prepared.clients[(index + 1) % 4].room(
    (room) => room.status === "playing" && room.players[index].reconnectDeadline === null,
  );
  expect(restored.game).toEqual(prepared.room.game);
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const current = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (current.status !== "playing") throw new Error("Not playing");
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...current,
        players: current.players.map((player) =>
          player.side === "east" ? { ...player, reconnectDeadline: Date.now() - 2 } : player,
        ),
        clock: { ...current.clock, turnExpiresAt: Date.now() - 1 },
      }),
    );
  });
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(prepared.id));
  const room = await get(prepared.id);
  if (room.status !== "playing") throw new Error("Not playing");
  expect(room.game.eliminations).toMatchObject([
    { side: "east", reason: "disconnected", rank: 4 },
    { side: "south", reason: "timeout", rank: 3 },
  ]);
  expect(room.game.turn).toBe("west");
  expect(room.positionRevision).toBe(2);
  const finished = await resignCurrent(prepared, room);
  if (finished.status !== "waiting") throw new Error("Not finished");
  await vi.waitFor(async () => {
    const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(finished.lastRound!.roundId)
      .first<{ record_json: string }>();
    expect(row).not.toBeNull();
    expect(readShogiMatchRecord(row!.record_json).knockouts).toEqual({
      south: 0,
      west: 0,
      north: 0,
      east: 0,
    });
  });
});

test("CPUは選択を保存した次のAlarmで期限を照合し、期限切れの選択を着手しない", async () => {
  const created = await create(true);
  const client = await connect(created.room.id, created.membership.token);
  client.send({ type: "room.game.start" });
  const started = await client.room((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Not playing");
  // A full engine state at a CPU turn is a persisted storage boundary fixture.
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const cpu = room.players.find((player) => player.kind === "cpu")!;
    const store = new ShogiStore(state.storage.sql);
    const game = store.loadState(room.roundId, room.game);
    if (game.status !== "playing") throw new Error("Not playing");
    const at = Date.now();
    const cpuState = { ...game, turn: cpu.side } as FourShogiState;
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        game: store.saveState(room.roundId, cpuState),
        legalActions: getLegalActions(cpuState),
        clock: { ...room.clock, turnStartedAt: at - 1000, turnExpiresAt: at + 60000 },
      }),
    );
    await instance.alarm();
    const job = state.storage.kv.get<{ side: Side; applyAt: number }>("shogi-cpu-job");
    expect(job).toMatchObject({ roundId: room.roundId, positionRevision: 0, side: cpu.side });
    const selected = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    expect(selected.game?.moveNumber).toBe(0);
    expect(state.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey)?.knockouts).toEqual({
      south: 0,
      west: 0,
      north: 0,
      east: 0,
    });
    state.storage.kv.put("shogi-cpu-job", { ...job, applyAt: Date.now() + 60000 });
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...selected,
        clock: { ...selected.clock, turnExpiresAt: Date.now() - 1 },
      }),
    );
    await state.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(created.room.id));
  const room = await get(created.room.id);
  if (room.status !== "playing") throw new Error("Not playing");
  expect(room.game.moveNumber).toBe(0);
  expect(room.game.eliminations[0]).toMatchObject({ reason: "timeout" });
  expect(room.positionRevision).toBe(1);
});

test("100件ずつの棋譜取得は局IDと部屋世代を検証し、次局開始で旧棋譜を破棄する", async () => {
  const prepared = await start();
  // Build a legal history without network timing affecting the pagination boundary.
  const initial = {
    mode: "singles" as const,
    players: prepared.room.game.players,
    threePlayerAttackProhibited: false,
  };
  let game = createInitialState(initial);
  const events: import("@tetraboard/protocol").FourShogiReplayEvent[] = [];
  let seed = 7;
  for (let index = 0; index < 105; index++) {
    if (game.status !== "playing") throw new Error("Fixture ended early");
    const actions = getLegalActions(game);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    let chosen = false;
    for (let offset = 0; offset < actions.length; offset++) {
      const action = actions[(seed + offset) % actions.length];
      const next = applyAction(game, game.turn, action);
      if (next.ok && next.state.status === "playing") {
        events.push({ type: "action", side: game.turn, action });
        game = next.state;
        chosen = true;
        break;
      }
    }
    if (!chosen) throw new Error("No continuing fixture action");
  }
  while (game.status === "playing") {
    const side = game.turn;
    const next = eliminateSide(game, side, "resigned");
    if (!next.ok) throw new Error("Fixture resignation failed");
    events.push({ type: "eliminate", side, reason: "resigned" });
    game = next.state;
  }
  const roundId = prepared.room.roundId;
  const final = game;
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const store = new ShogiStore(state.storage.sql);
    store.startReplay(roundId, initial);
    for (const event of events) store.appendEvent(roundId, event);
    const core = store.saveState(roundId, final);
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...prepared.room,
        status: "waiting",
        game: null,
        clock: null,
        roundId: null,
        positionRevision: 0,
        legalActions: [],
        checkState: { south: false, west: false, north: false, east: false },
        eliminations: [],
        players: prepared.room.players.map((player) => ({ ...player, side: null, ready: false })),
        lastRound: {
          roundId,
          game: core,
          players: prepared.room.players.map((player) => ({
            id: player.id,
            name: player.name,
            side: player.side,
          })),
          eventCount: events.length,
        },
      }),
    );
  });
  const url = `${getFourShogiReplayContract.pathFor(prepared.id, roundId)}?instanceId=${prepared.room.instanceId}`;
  const first = getFourShogiReplayContract.response.parse(await (await request(url)).json());
  expect(first.events).toHaveLength(100);
  expect(first.events[0].index).toBe(0);
  expect(first.events[99].index).toBe(99);
  expect(first.nextCursor).toBe(100);
  const last = getFourShogiReplayContract.response.parse(
    await (await request(`${url}&cursor=${first.nextCursor}`)).json(),
  );
  expect(last.events).toHaveLength(events.length - 100);
  expect(last.events[0].index).toBe(100);
  expect(last.eventCount).toBe(first.eventCount);
  expect(last.nextCursor).toBeNull();
  expect([...first.events, ...last.events].map((entry) => entry.event)).toEqual(events);
  for (let index = 0; index < 4; index++) {
    prepared.clients[index].send({ type: "room.ready.set", ready: true });
    await prepared.clients[0].room(
      (room) =>
        room.status === "waiting" &&
        room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  prepared.clients[0].send({ type: "room.game.start" });
  const newRound = await prepared.clients[0].room((room) => room.status === "playing");
  expect(newRound.roundId).not.toBe(roundId);
  expect((await request(url)).status).toBe(404);
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    expect(
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM shogi_rounds").one()
        .count,
    ).toBe(1);
    expect(
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM shogi_events").one()
        .count,
    ).toBe(0);
    const saved = state.storage.kv.get<{ game: object }>("room")!;
    expect(saved.game).not.toHaveProperty("repetitions");
    expect(
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM shogi_repetitions")
        .one().count,
    ).toBe(1);
  });
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
  ).toBe(true);
  expect(
    roomSocketContract.clientMessage.safeParse({
      type: "room.game.action",
      action: { type: "dropPiece", pieceKind: "pawn", to: { x: 1, y: 1 } },
      roundId: crypto.randomUUID(),
      positionRevision: 0,
    }).success,
  ).toBe(true);
});

test("CPUの保存した合法手を次のAlarmで一度だけ適用し、revisionが違う選択を破棄する", async () => {
  const created = await create(true);
  const client = await connect(created.room.id, created.membership.token);
  client.send({ type: "room.game.start" });
  await client.room((room) => room.status === "playing");
  const cpu = await runInDurableObject(
    env.GAME_ROOM.getByName(created.room.id),
    async (instance, state) => {
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const cpu = room.players.find((player) => player.kind === "cpu")!;
      const store = new ShogiStore(state.storage.sql);
      const core = store.loadState(room.roundId, room.game);
      const game = { ...core, status: "playing" as const, result: null, turn: cpu.side };
      const at = Date.now();
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          game: store.saveState(room.roundId, game),
          legalActions: getLegalActions(game),
          clock: { ...room.clock, turnStartedAt: at - 1000, turnExpiresAt: at + 60000 },
        }),
      );
      await instance.alarm();
      const job = state.storage.kv.get<Record<string, unknown>>("shogi-cpu-job")!;
      expect(job).toBeTruthy();
      state.storage.kv.put("shogi-cpu-job", { ...job, applyAt: Date.now() + 60000 });
      await state.storage.setAlarm(Date.now() + 60000);
      return { side: cpu.side, job };
    },
  );
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, state) => {
    state.storage.kv.put("shogi-cpu-job", { ...cpu.job, applyAt: Date.now() - 1 });
    await instance.alarm();
    const moved = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    expect(moved.game?.moveNumber).toBe(1);
    expect(moved.positionRevision).toBe(1);
    expect(moved.game?.lastMove?.side).toBe(cpu.side);
    expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
    await state.storage.setAlarm(Date.now() + 60000);
  });
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const cpuPlayer = room.players.find((player) => player.kind === "cpu")!;
    const store = new ShogiStore(state.storage.sql);
    const game = {
      ...store.loadState(room.roundId, room.game),
      status: "playing" as const,
      result: null,
      turn: cpuPlayer.side,
    };
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        game: store.saveState(room.roundId, game),
        legalActions: getLegalActions(game),
        clock: {
          ...room.clock,
          turnStartedAt: Date.now() - 1000,
          turnExpiresAt: Date.now() + 60000,
        },
      }),
    );
    state.storage.kv.put("shogi-cpu-job", {
      ...cpu.job,
      roundId: room.roundId,
      positionRevision: 0,
      side: cpuPlayer.side,
      applyAt: Date.now() - 1,
    });
    await instance.alarm();
    expect(fourShogiRoomSchema.parse(state.storage.kv.get("room")).game?.moveNumber).toBe(1);
    expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
    await state.storage.setAlarm(Date.now() + 60000);
  });
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
        legalActions: getLegalActions(fixture),
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

test("切断中のログイン者が時間切れでも元の復帰期限を延長せず、期限後に席制限を解除する", async () => {
  const user = await accountFixture();
  const createAccount = () =>
    exports.default.fetch(
      new Request(`${origin}/api/rooms`, {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ game: "four-shogi", mode: "singles", quickPlay: true }),
      }),
    );
  const response = await createAccount();
  expect(response.status).toBe(201);
  const entry = createRoomContract.response.parse(await response.json());
  const id = entry.room.id;
  const host = await connect(id, entry.membership.token);
  const observer = await connect(id);
  host.send({ type: "room.game.start" });
  const started = await observer.room((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Not playing");
  host.close();
  const disconnected = await observer.room((room) => room.players[0].reconnectDeadline !== null);
  const deadline = disconnected.players[0].reconnectDeadline!;
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const store = new ShogiStore(state.storage.sql);
    const game = {
      ...store.loadState(room.roundId, room.game),
      status: "playing" as const,
      result: null,
      turn: room.players[0].side,
    };
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        game: store.saveState(room.roundId, game),
        legalActions: getLegalActions(game),
        clock: { ...room.clock, turnExpiresAt: Date.now() - 1 },
      }),
    );
  });
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(id));
  const timedOut = await get(id);
  expect(timedOut.players[0].reconnectDeadline).toBe(deadline);
  expect(timedOut.game?.eliminations[0]).toMatchObject({ reason: "timeout" });
  expect((await createAccount()).status).toBe(409);
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        players: room.players.map((player) =>
          player.id === entry.membership.playerId
            ? { ...player, reconnectDeadline: Date.now() - 1 }
            : player,
        ),
      }),
    );
  });
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(id));
  expect((await createAccount()).status).toBe(201);
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
        legalActions: getLegalActions(fixture),
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

test("導入前の進行局は開始メタデータを推測して恒久保存しない", async () => {
  const prepared = await start();
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) =>
    state.storage.kv.delete(shogiMatchStartKey),
  );
  let room: FourShogiRoom = prepared.room;
  while (room.status === "playing") room = await resignCurrent(prepared, room);
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?")
      .bind(prepared.room.roundId)
      .first(),
  ).toBeNull();
  expect(
    await runInDurableObject(
      env.GAME_ROOM.getByName(prepared.id),
      (_instance, state) =>
        new Map(state.storage.kv.list({ prefix: pendingShogiMatchPrefix })).size,
    ),
  ).toBe(0);
});

test("将棋の保存失敗中も再戦・閉鎖・番号再利用をまたいで棋譜を保持し、5秒再送で復旧する", async () => {
  const prepared = await start();
  const stub = env.GAME_ROOM.getByName(prepared.id);
  const ids: string[] = [];
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO matches_unavailable");
  try {
    let room: FourShogiRoom = prepared.room;
    for (let round = 0; round < 2; round++) {
      if (round > 0) {
        for (let index = 0; index < 4; index++) {
          prepared.clients[index].send({ type: "room.ready.set", ready: true });
          await prepared.clients[0].room(
            (next) => next.players.filter((player) => player.ready).length === index + 1,
          );
        }
        prepared.clients[0].send({ type: "room.game.start" });
        room = await prepared.clients[0].room((next) => next.status === "playing");
      }
      if (room.status !== "playing") throw new Error("Not playing");
      ids.push(room.roundId);
      // 再戦で担当方向が再抽選されるため、この局の席対応を使います。
      const currentPrepared = { ...prepared, room };
      while (room.status === "playing") room = await resignCurrent(currentPrepared, room);
    }
    await vi.waitFor(async () => {
      const jobs = await runInDurableObject(stub, (_instance, state) => [
        ...new Map(
          state.storage.kv.list<PendingShogiMatch>({ prefix: pendingShogiMatchPrefix }),
        ).values(),
      ]);
      expect(jobs).toHaveLength(2);
      expect(
        jobs.every((job) => job.retryAtMs > Date.now() && job.retryAtMs <= Date.now() + 5000),
      ).toBe(true);
    });
    const waiting = await get(prepared.id);
    for (const member of prepared.memberships)
      expect(
        (
          await request(`/rooms/${prepared.id}/leave`, {
            method: "POST",
            headers: { Authorization: `Bearer ${member.token}` },
          })
        ).status,
      ).toBe(204);
    expect(
      await runInDurableObject(stub, (_instance, state) => ({
        archives: state.storage.sql
          .exec("SELECT round_id FROM shogi_archives ORDER BY round_id")
          .toArray(),
        events: state.storage.sql.exec("SELECT COUNT(*) AS n FROM shogi_events").one(),
      })),
    ).toEqual({ archives: [...ids].sort().map((round_id) => ({ round_id })), events: { n: 6 } });
    const replacement = fourShogiRoomSchema.parse({
      ...waiting,
      instanceId: crypto.randomUUID(),
      lastRound: null,
      players: [{ ...waiting.players[0], id: crypto.randomUUID() }],
      lastActivityAtMs: Date.now(),
    });
    expect(await stub.createRoom(replacement, "a".repeat(64))).not.toBeNull();
  } finally {
    await env.APP_DB.exec("ALTER TABLE matches_unavailable RENAME TO matches");
  }
  for (let pass = 0; pass < 4; pass++) {
    await runInDurableObject(stub, async (_instance, state) => {
      for (const [key, job] of state.storage.kv.list<PendingShogiMatch>({
        prefix: pendingShogiMatchPrefix,
      }))
        state.storage.kv.put(key, { ...job, retryAtMs: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60000);
    });
    await runDurableObjectAlarm(stub);
  }
  await vi.waitFor(async () => {
    for (const id of ids) {
      const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
        .bind(id)
        .first<{ record_json: string }>();
      expect(readShogiMatchRecord(row!.record_json).knockouts).toEqual({
        south: 0,
        west: 0,
        north: 0,
        east: 0,
      });
      expect(
        await env.APP_DB.prepare(
          "SELECT SUM(event_count) AS n FROM shogi_match_chunks WHERE match_id = ?",
        )
          .bind(id)
          .first(),
      ).toEqual({ n: 3 });
    }
    expect(
      await runInDurableObject(stub, (_instance, state) => ({
        pending: new Map(state.storage.kv.list({ prefix: pendingShogiMatchPrefix })).size,
        archives: state.storage.sql.exec("SELECT COUNT(*) AS n FROM shogi_archives").one(),
        events: state.storage.sql.exec("SELECT COUNT(*) AS n FROM shogi_events").one(),
      })),
    ).toEqual({ pending: 0, archives: { n: 0 }, events: { n: 0 } });
  });
});

test("対局中のホスト退出では公開一覧の旧ホスト名を消し、対局を継続する", async () => {
  const prepared = await start();
  const response = await request(`/rooms/${prepared.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${prepared.memberships[0].token}` },
  });
  expect(response.status).toBe(204);
  const snapshot = getRoomContract.response.parse(
    await (await request(`/rooms/${prepared.id}`)).json(),
  );
  expect(snapshot.presence.hostPlayerId).toBeNull();
  const room = fourShogiRoomSchema.parse(snapshot.room);
  expect(room.status).toBe("playing");
  expect(room.publicUpdatedAtMs).toBeGreaterThan(prepared.room.publicUpdatedAtMs);
  expect(room.players).toHaveLength(4);
  let cursor: string | null = null;
  let found: import("@tetraboard/protocol").RoomPublicMetadata | undefined;
  do {
    const query = new URLSearchParams({ game: "four-shogi" });
    if (cursor) query.set("cursor", cursor);
    const page = listRoomsContract.response.parse(await (await request(`/rooms?${query}`)).json());
    found = page.rooms.find((entry) => entry.id === prepared.id);
    cursor = page.nextCursor;
  } while (!found && cursor);
  expect(found).toMatchObject({ hostName: null, hostAvatarUrl: null, status: "playing" });
});
