import { fixTestTime } from "./fixedTimeFixture";
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  getLegalActions,
} from "@tetraboard/four-shogi";
import {
  getFourShogiReplayContract,
  fourShogiRoomSchema,
  type FourShogiRoom,
} from "@tetraboard/protocol";
import { ShogiStore } from "../src/rooms/shogiStore";
import {
  pendingShogiMatchPrefix,
  readShogiMatchRecord,
  shogiMatchStartKey,
  type PendingShogiMatch,
} from "../src/rooms/shogiMatchStore";
import {
  registerFourShogiRoomFixtures,
  start,
  request,
  resignCurrent,
  sideIndex,
  get,
} from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

test("進行中の棋譜と廃止したprefix指定を拒否し、終局後は全イベントを返す", async () => {
  const prepared = await start();
  let room: FourShogiRoom = prepared.room;
  const path = `${getFourShogiReplayContract.pathFor(prepared.id, room.roundId)}?instanceId=${room.instanceId}`;
  expect((await request(path)).status).toBe(404);
  expect((await request(`${path}&throughEventCount=0`)).status).toBe(400);
  while (room.status === "playing") room = await resignCurrent(prepared, room);
  const response = await request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const final = getFourShogiReplayContract.response.parse(await response.json());
  expect(final.eventCount).toBe(room.lastRound?.eventCount);
  expect(final.events).toHaveLength(3);
  expect(final.events.every(({ event }) => event.type === "eliminate")).toBe(true);
  expect(final.nextCursor).toBeNull();
  expect((await request(`${path}&throughEventCount=1`)).status).toBe(400);
  const serialized = JSON.stringify(final);
  expect(serialized).not.toContain(prepared.memberships[0].token);
  expect(serialized).not.toContain("accountId");
  expect(serialized).not.toContain("chat");
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
        : event.type === "eliminate"
          ? eliminateSide(reconstructed, event.side, event.reason)
          : setDrawProposal(reconstructed, event.side, event.proposed);
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

test("将棋の保存失敗中も再戦・未決着の打ち切り・番号再利用をまたいで棋譜を保持し、5秒再送で復旧する", async () => {
  fixTestTime();
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
    for (const member of prepared.memberships.slice(1))
      expect(
        (
          await request(`/rooms/${prepared.id}/leave`, {
            method: "POST",
            headers: { Authorization: `Bearer ${member.token}` },
          })
        ).status,
      ).toBe(204);
    for (let count = 2; count <= 4; count++) {
      prepared.clients[0].send({ type: "room.cpu.add", level: 1 });
      await prepared.clients[0].room((room) => room.players.length === count);
    }
    prepared.clients[0].send({ type: "room.ready.set", ready: true });
    await prepared.clients[0].room((room) => room.players.every((player) => player.ready));
    prepared.clients[0].send({ type: "room.game.start" });
    const interrupted = await prepared.clients[0].room((room) => room.status === "playing");
    if (interrupted.status !== "playing") throw new Error("Not playing");
    expect(
      (
        await request(`/rooms/${prepared.id}/leave`, {
          method: "POST",
          headers: { Authorization: `Bearer ${prepared.memberships[0].token}` },
        })
      ).status,
    ).toBe(204);
    expect((await request(`/rooms/${prepared.id}`)).status).toBe(404);
    expect(
      await runInDurableObject(
        stub,
        (_, state) => new Map(state.storage.kv.list({ prefix: pendingShogiMatchPrefix })).size,
      ),
    ).toBe(2);
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
          "SELECT SUM(event_count) AS n FROM match_event_chunks WHERE match_id = ?",
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
