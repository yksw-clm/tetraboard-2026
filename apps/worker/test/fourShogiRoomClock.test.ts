import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { getLegalActions } from "@tetraboard/four-shogi";
import { createRoomContract, listRoomsContract, fourShogiRoomSchema } from "@tetraboard/protocol";
import { ShogiStore } from "../src/rooms/shogiStore";
import { readShogiMatchRecord } from "../src/rooms/shogiMatchStore";
import { accountFixture, origin } from "./accountFixtures";
import {
  registerFourShogiRoomFixtures,
  start,
  sideIndex,
  connect,
  get,
  resignCurrent,
  setup,
  request,
} from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

test("接続復帰は期限を解除し、通信期限切れと時計期限はサーバーで脱落処理する", async () => {
  const prepared = await start();
  const index = sideIndex(prepared, "east");
  prepared.clients[index].close();
  const disconnected = await prepared.clients[(index + 1) % 4].room(
    (room) => room.status === "playing" && room.players[index].reconnectDeadline !== null,
  );
  expect(disconnected.players[index].reconnectDeadline).not.toBeNull();
  prepared.clients[index] = await connect(prepared.id, prepared.memberships[index].token);
  const restored = await prepared.clients[(index + 1) % 4].room(
    (room) => room.status === "playing" && room.players[index].reconnectDeadline === null,
  );
  expect(restored.game).toEqual(prepared.room.game);
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const current = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (current.status !== "playing") throw new Error("Not playing");
    const at = Date.now();
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...current,
        players: current.players.map((player) =>
          player.side === "east" ? { ...player, reconnectDeadline: at - 2 } : player,
        ),
        clock: { ...current.clock, turnExpiresAt: at - 1 },
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

test("切断中のログイン者が時間切れでも元の復帰期限を延長せず、期限後に席制限を解除する", async () => {
  const user = await accountFixture();
  const createAccount = () =>
    exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/rooms`, {
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

test("将棋の時間設定もホスト限定で準備を解除し、同値再送・開始後の変更を扱う", async () => {
  const prepared = await setup();
  const host = prepared.clients[0];
  const observer = await connect(prepared.id);
  const control = { mainTimeMs: 60_000, byoyomiMs: 10_000 } as const;
  prepared.clients[1].send({ type: "room.time-control.set", timeControl: control });
  expect(await prepared.clients[1].error()).toBe("forbidden");
  observer.send({ type: "room.time-control.set", timeControl: control });
  expect(await observer.error()).toBe("unauthorized");
  host.send({ type: "room.time-control.set", timeControl: { mainTimeMs: 0, byoyomiMs: 0 } });
  expect(await host.error()).toBe("invalid_request");
  host.send({ type: "room.time-control.set", timeControl: control });
  const changed = await host.room((room) => room.settings.timeControl.mainTimeMs === 60_000);
  expect(changed.players.every((p) => !p.ready)).toBe(true);
  expect(
    (await observer.room((room) => room.settings.timeControl.mainTimeMs === 60_000)).settings
      .timeControl,
  ).toEqual(control);
  expect((await get(prepared.id)).settings.timeControl).toEqual(control);
  await vi.waitFor(async () => {
    const listing = await request("/rooms?game=four-shogi");
    expect(
      listRoomsContract.response
        .parse(await listing.json())
        .rooms.find((room) => room.id === prepared.id)?.timeControl,
    ).toEqual(control);
  });
  for (let i = 0; i < 4; i++) {
    prepared.clients[i].send({ type: "room.ready.set", ready: true });
    await host.room((room) => room.players.filter((p) => p.ready).length === i + 1);
  }
  const ready = await get(prepared.id);
  host.send({ type: "room.time-control.set", timeControl: control });
  const unchanged = await host.room((room) => room.players.every((p) => p.ready));
  expect(unchanged.publicUpdatedAtMs).toBe(ready.publicUpdatedAtMs);
  expect(unchanged.lastActivityAtMs).toBe(ready.lastActivityAtMs);
  host.send({ type: "room.game.start" });
  const started = await host.room((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Not playing");
  expect(started.clock.turnExpiresAt - started.clock.turnStartedAt).toBe(70_000);
  host.send({
    type: "room.time-control.set",
    timeControl: { mainTimeMs: 300_000, byoyomiMs: 30_000 },
  });
  expect(await host.error()).toBe("already_started");
});

test.each([
  { mainTimeMs: 0, byoyomiMs: 10_000 },
  { mainTimeMs: 60_000, byoyomiMs: 0 },
  { mainTimeMs: 180_000, byoyomiMs: 30_000 },
] as const)("将棋の着手・時間切れは $mainTimeMs + $byoyomiMs を使う", async (control) => {
  const prepared = await setup("singles", control);
  const host = prepared.clients[0];
  host.send({ type: "room.game.start" });
  const started = await host.room((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Not playing");
  expect(started.clock.turnExpiresAt - started.clock.turnStartedAt).toBe(
    control.mainTimeMs + control.byoyomiMs,
  );
  const index = started.players.findIndex((p) => p.side === started.game.turn);
  prepared.clients[index].send({
    type: "room.game.action",
    roundId: started.roundId,
    positionRevision: started.positionRevision,
    action: started.legalActions[0],
  });
  const moved = await host.room(
    (room) => room.status === "playing" && room.positionRevision > started.positionRevision,
  );
  if (moved.status !== "playing") throw new Error("Not playing");
  expect(moved.clock.turnExpiresAt - moved.clock.turnStartedAt).toBe(
    control.mainTimeMs + control.byoyomiMs,
  );
  const turn = moved.game.turn;
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    state.storage.kv.put("room", {
      ...moved,
      clock: { ...moved.clock, turnExpiresAt: Date.now() },
    });
  });
  const turnIndex = moved.players.findIndex((p) => p.side === turn);
  prepared.clients[turnIndex].send({
    type: "room.game.action",
    roundId: moved.roundId,
    positionRevision: moved.positionRevision,
    action: moved.legalActions[0],
  });
  expect(await prepared.clients[turnIndex].error()).toBe("stale_position");
  const expired = await host.room((room) =>
    room.eliminations.some((entry) => entry.side === turn && entry.reason === "timeout"),
  );
  if (expired.status !== "playing") throw new Error("Not playing");
  expect(expired.clock.turnExpiresAt - expired.clock.turnStartedAt).toBe(
    control.mainTimeMs + control.byoyomiMs,
  );
});
