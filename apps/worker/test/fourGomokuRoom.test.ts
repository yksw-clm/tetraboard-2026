import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import {
  isFourGomokuRoom,
  publicFourGomokuMatchDetailSchema,
  type FourGomokuRoom,
  type RoomMode,
} from "@tetraboard/protocol";
import { fourGomokuCpuJobKey, type FourGomokuCpuJob } from "../src/rooms/fourGomokuProgress";
import {
  RoomBoundaryFixtures,
  boundaryRequest,
  boundaryJson,
  type BoundarySocket,
} from "./roomBoundaryFixtures";
let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});
function gameRoom(room: Awaited<ReturnType<RoomBoundaryFixtures["snapshot"]>>["room"]) {
  if (!isFourGomokuRoom(room)) throw Error("wrong game");
  return room;
}
async function setup(mode: RoomMode = "singles") {
  const entry = await fixtures.create({
    name: "ホスト",
    game: "four-gomoku",
    mode,
    quickPlay: false,
  });
  const host = await fixtures.connect(entry);
  const clients = new Map<string, BoundarySocket>([[entry.membership.playerId, host]]);
  for (let i = 1; i < 4; i++) {
    const joined = await fixtures.join(entry.room.id, `参加者${i}`);
    const client = await fixtures.connect(joined);
    clients.set(joined.membership.playerId, client);
    client.send({ type: "room.ready.set", ready: true });
    await host.waitFor(
      "room.snapshot",
      (m) => m.room.players.find((p) => p.id === joined.membership.playerId)?.ready === true,
    );
  }
  host.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const room = gameRoom(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  return { entry, host, clients, room };
}
function current(room: FourGomokuRoom, clients: Map<string, BoundarySocket>) {
  if (room.status !== "playing") throw Error("not playing");
  return clients.get(room.players.find((p) => p.color === room.game.turn)!.id)!;
}
async function play(
  room: FourGomokuRoom,
  clients: Map<string, BoundarySocket>,
  host: BoundarySocket,
  x: number,
  y: number,
) {
  if (room.status !== "playing") throw Error("not playing");
  const n = room.game.moveNumber;
  current(room, clients).send({
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: { type: "placeFourGomokuStone", position: { x, y } },
  });
  return gameRoom(
    (
      await host.waitFor(
        "room.snapshot",
        (m) => m.room.status === "waiting" || m.room.game.moveNumber > n,
      )
    ).room,
  );
}
async function firstWinner(
  room: FourGomokuRoom,
  clients: Map<string, BoundarySocket>,
  host: BoundarySocket,
) {
  for (let x = 0; x < 4; x++)
    for (let y = 0; y < 4; y++) room = await play(room, clients, host, x, y * 2);
  return play(room, clients, host, 4, 0);
}
test("4席・両モード・禁手設定なし、5人目と禁手コマンドを拒否", async () => {
  const { entry, host, room } = await setup();
  expect(room.players).toHaveLength(4);
  expect(room.settings).not.toHaveProperty("forbiddenRules");
  expect(room.players.map((p) => p.color).sort()).toEqual(["black", "blue", "red", "white"]);
  expect(
    (await boundaryRequest(`/rooms/${room.id}/players`, boundaryJson({ name: "5人目" }))).status,
  ).toBe(409);
  expect(
    (
      await boundaryRequest(
        "/rooms",
        boundaryJson({
          game: "four-gomoku",
          name: "不正",
          quickPlay: false,
          forbiddenRules: false,
        }),
      )
    ).status,
  ).toBe(400);
  host.send({ type: "room.gomoku-forbidden.set", enabled: false });
  expect((await host.waitFor("room.error")).error).toBe("invalid_request");
  const response = await boundaryRequest("/rooms?game=four-gomoku");
  expect(JSON.stringify(await response.json())).toContain(entry.room.id);
});
test("1位で保存せず続行、全順位確定後に1局保存して再戦。旧revisionと勝ち抜け後の操作を拒否", async () => {
  const { entry, host, clients, room: initial } = await setup();
  let room = await firstWinner(initial, clients, host);
  if (room.status !== "playing") throw Error("ended early");
  expect(room.game.standings).toEqual([{ color: "black", rank: 1, reason: "five" }]);
  expect(room.game.turn).toBe("white");
  const id = room.roundId;
  expect(await env.APP_DB.prepare("SELECT id FROM matches WHERE id=?").bind(id).first()).toBeNull();
  const winner = clients.get(room.players.find((p) => p.color === "black")!.id)!;
  winner.send({ type: "room.game.resign" });
  expect((await winner.waitFor("room.error")).error).toBe("already_eliminated");
  current(room, clients).send({
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: 0,
    action: { type: "placeFourGomokuStone", position: { x: 4, y: 2 } },
  });
  expect((await current(room, clients).waitFor("room.error")).error).toBe("stale_position");
  room = await play(room, clients, host, 4, 2);
  room = await play(room, clients, host, 4, 4);
  if (room.status !== "waiting") throw Error("not ended");
  expect(room.lastRound!.game.standings.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
  expect(room.players.every((p) => !p.ready)).toBe(true);
  await fixtures.snapshot(entry.room.id);
  const response = await boundaryRequest(`/matches/${id}`);
  expect(response.status).toBe(200);
  const saved = publicFourGomokuMatchDetailSchema.parse(
    ((await response.json()) as { match: unknown }).match,
  );
  expect(saved.game).toEqual(room.lastRound!.game);
  expect(saved.replay.steps).toHaveLength(19);
  const previous = structuredClone(room.lastRound);
  host.send({ type: "room.mode.set", mode: "doubles" });
  const changed = gameRoom(
    (await host.waitFor("room.snapshot", (m) => m.room.settings.mode === "doubles")).room,
  );
  expect(changed.players.every((p) => !p.ready)).toBe(true);
  expect(changed.lastRound).toEqual(previous);
  for (const client of clients.values()) client.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const next = gameRoom(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  expect(next.lastRound).toBeNull();
  expect(next.game?.mode).toBe("doubles");
  expect(next.game?.standings).toEqual([]);
  expect(next.game?.moveNumber).toBe(0);
});
test("勝ち抜け後の切断期限は順位を変えず、未確定者の時間切れは下位から1回だけ確定", async () => {
  const { entry, host, clients, room: initial } = await setup();
  let room = await firstWinner(initial, clients, host);
  if (room.status !== "playing") throw Error();
  const winner = room.players.find((p) => p.color === "black")!;
  clients.get(winner.id)!.close();
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  await runInDurableObject(stub, (_instance, state) => {
    const saved = gameRoom(state.storage.kv.get("room") as FourGomokuRoom);
    if (saved.status !== "playing") throw Error();
    const p = saved.players.find((p) => p.id === winner.id)!;
    p.reconnectDeadline = Date.now() - 1;
    saved.clock.turnExpiresAt = Date.now();
    state.storage.kv.put("room", saved);
  });
  await runDurableObjectAlarm(stub);
  room = gameRoom((await fixtures.snapshot(entry.room.id)).room);
  if (room.status !== "playing") throw Error();
  expect(room.game.standings).toContainEqual({ color: "black", rank: 1, reason: "five" });
  expect(room.game.standings).toContainEqual({ color: "white", rank: 4, reason: "timeout" });
  expect(room.game.turn).toBe("red");
  expect(room.game.board[0][0]).toBe("black");
  expect(room.eliminations).toEqual([{ color: "white", reason: "timeout" }]);
  fixtures.forgetDepartedPlayer(winner.id);
});
test.each(["five", "resign"] as const)(
  "ダブルスの混色完成または1人の脱落で両チームの結果を確定: %s",
  async (kind) => {
    const { host, clients, room: initial } = await setup("doubles");
    let room = initial;
    if (kind === "resign") {
      current(room, clients).send({ type: "room.game.resign" });
      room = gameRoom(
        (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
      );
    } else {
      for (const [x, y] of [
        [0, 0],
        [0, 10],
        [1, 0],
        [0, 12],
        [2, 0],
        [2, 10],
        [3, 0],
        [2, 12],
        [4, 0],
      ])
        room = await play(room, clients, host, x, y);
    }
    expect(room.lastRound?.game.result).toEqual({
      mode: "doubles",
      reason: kind === "five" ? "five" : "team_eliminated",
      winner: kind === "five" ? "black-red" : "white-blue",
    });
    expect(room.lastRound?.game.standings).toEqual([]);
  },
);
test.each([1, 2] as const)("すぐ遊ぶのCPU3人と、CPU候補の期限優先: Lv%s", async (level) => {
  const entry = await fixtures.create({
    game: "four-gomoku",
    name: "ホスト",
    mode: "singles",
    quickPlay: true,
    cpuLevel: level,
  });
  const host = await fixtures.connect(entry);
  expect(entry.room.players.filter((p) => p.kind === "cpu")).toHaveLength(3);
  expect(entry.room.settings.timeControl).toEqual({ mainTimeMs: 300000, byoyomiMs: 30000 });
  host.send({ type: "room.game.start" });
  let room = gameRoom(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  if (room.status !== "playing") throw Error();
  const firstTurn = room.game.turn;
  if (room.players.find((p) => p.color === firstTurn)?.kind === "human")
    room = await play(room, new Map([[entry.membership.playerId, host]]), host, 7, 7);
  if (room.status !== "playing") throw Error();
  const before = room.game.moveNumber;
  const color = room.game.turn;
  const stub = env.GAME_ROOM.getByName(room.id);
  await runInDurableObject(stub, async (instance, state) => {
    const saved = gameRoom(state.storage.kv.get("room") as FourGomokuRoom);
    if (saved.status !== "playing") throw Error();
    saved.clock.turnStartedAt = Date.now() - 2001;
    state.storage.kv.put("room", saved);
    await instance.alarm();
    const job = state.storage.kv.get<FourGomokuCpuJob>(fourGomokuCpuJobKey)!;
    expect(job.color).toBe(color);
    state.storage.kv.put(fourGomokuCpuJobKey, { ...job, applyAt: Date.now() - 1 });
    if (level === 2) {
      saved.clock.turnExpiresAt = Date.now();
      state.storage.kv.put("room", saved);
    }
  });
  await runDurableObjectAlarm(stub);
  const after = gameRoom((await fixtures.snapshot(room.id)).room);
  expect(after.game?.moveNumber).toBe(before + (level === 1 ? 1 : 0));
  if (level === 2)
    expect(after.game?.standings).toContainEqual({ color, rank: 4, reason: "timeout" });
});

test("保存失敗後に部屋を閉鎖しても保存待ちを保持し、復旧後の再送で1局だけ保存する", async () => {
  const { entry, host, clients, room } = await setup("doubles");
  if (room.status !== "playing") throw Error("not playing");
  const turn = room.game.turn;
  const player = room.players.find((p) => p.color === turn)!;
  const active = clients.get(player.id)!;
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  let id = "";
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO four_gomoku_save_unavailable");
  try {
    active.send({ type: "room.game.resign" });
    const ended = gameRoom(
      (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
    );
    id = ended.lastRound!.replay.id;
    await fixtures.snapshot(entry.room.id);
    const pending = await runInDurableObject(stub, (_instance, state) =>
      state.storage.kv.get<{ record: { id: string }; retryAtMs: number }>(`match-pending:${id}`),
    );
    expect(pending?.record.id).toBe(id);
    expect(pending?.retryAtMs).toBeGreaterThan(Date.now());
    await fixtures.dispose();
    fixtures = new RoomBoundaryFixtures();
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.kv.get("room")),
    ).toBeUndefined();
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.get(`match-pending:${id}`),
      ),
    ).toBeDefined();
  } finally {
    await env.APP_DB.exec("ALTER TABLE four_gomoku_save_unavailable RENAME TO matches");
  }
  await runInDurableObject(stub, async (_instance, state) => {
    const key = `match-pending:${id}`;
    const job = state.storage.kv.get<{ record: unknown; retryAtMs: number }>(key);
    if (!job) throw Error("Missing pending save");
    state.storage.kv.put(key, { ...job, retryAtMs: Date.now() - 1 });
    await state.storage.setAlarm(Date.now());
  });
  await runDurableObjectAlarm(stub);
  await vi.waitFor(async () => {
    expect(
      await env.APP_DB.prepare("SELECT COUNT(*) AS count FROM matches WHERE id=?").bind(id).first(),
    ).toEqual({ count: 1 });
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.kv.get(`match-pending:${id}`),
      ),
    ).toBeUndefined();
  });
  expect((await boundaryRequest(`/matches/${id}`)).status).toBe(200);
});

test("局ID・revision・担当色が古いCPU候補は適用せず破棄する", async () => {
  const entry = await fixtures.create({
    game: "four-gomoku",
    mode: "singles",
    name: "ホスト",
    quickPlay: true,
  });
  const host = await fixtures.connect(entry);
  host.send({ type: "room.game.start" });
  let room = gameRoom(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  if (room.status !== "playing") throw Error();
  const first = room.game.turn;
  if (room.players.find((p) => p.color === first)?.kind === "human")
    room = await play(room, new Map([[entry.membership.playerId, host]]), host, 7, 7);
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  for (const mismatch of ["roundId", "positionRevision", "color"])
    await runInDurableObject(stub, async (instance, state) => {
      const saved = gameRoom(state.storage.kv.get("room") as FourGomokuRoom);
      if (saved.status !== "playing") throw Error();
      saved.clock.turnStartedAt = Date.now() - 2001;
      state.storage.kv.put("room", saved);
      const job: FourGomokuCpuJob = {
        roundId: saved.roundId,
        positionRevision: saved.positionRevision,
        color: saved.game.turn,
        move: { x: 14, y: 14 },
        applyAt: Date.now() - 1,
      };
      if (mismatch === "roundId") job.roundId = crypto.randomUUID();
      if (mismatch === "positionRevision") job.positionRevision--;
      if (mismatch === "color") job.color = saved.game.turn === "black" ? "white" : "black";
      state.storage.kv.put(fourGomokuCpuJobKey, job);
      await instance.alarm();
      expect(state.storage.kv.get(fourGomokuCpuJobKey)).toBeUndefined();
      expect(gameRoom(state.storage.kv.get("room") as FourGomokuRoom).game).toEqual(saved.game);
    });
});
