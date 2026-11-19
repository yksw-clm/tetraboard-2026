import { fixTestTime } from "./fixedTimeFixture";
import { expectVersionedRoom } from "./roomStateVersionAssertions";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  matchmakingRules as rules,
  roomSchema,
  reversiRoomSchema,
  shogiRoomSchema,
  matchmakingQueues,
  fourShogiRoomSchema,
} from "@tetraboard/protocol";
import { origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { matchmakingCredential } from "../src/adapters/matchmaking/credential";
import { recordUsageEvents } from "./usageEventsRecorder";
import {
  useMatchmakingFixtures,
  stub,
  shogiQueue,
  rooms,
  fixture,
  connect,
} from "./matchmakingFixtures";

useMatchmakingFixtures();

test.each([
  { game: "four-shogi", seats: 4, mainTimeMs: 0, byoyomiMs: 30_000, duration: 30_000 },
  { game: "four-reversi", seats: 4, mainTimeMs: 0, byoyomiMs: 30_000, duration: 30_000 },
  { game: "shogi", seats: 2, mainTimeMs: 600_000, byoyomiMs: 0, duration: 600_000 },
  { game: "reversi", seats: 2, mainTimeMs: 300_000, byoyomiMs: 0, duration: 300_000 },
] as const)(
  "$gameのレート戦は指定時計で開始し、復元後も期限直前まで進行して期限ちょうどに時間切れになる",
  async ({ game, seats, mainTimeMs, byoyomiMs, duration }) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    const users = await fixture(seats, queue);
    const states = await Promise.all(users.map((u) => queue.status(u.account.id, u.controllerId)));
    const assignment = states[0]!.assignment!;
    rooms.add(assignment.roomId);
    const roomStub = env.GAME_ROOM.getByName(assignment.roomId);
    await expectVersionedRoom(roomStub);
    const schema =
      game === "four-shogi"
        ? fourShogiRoomSchema
        : game === "four-reversi"
          ? roomSchema
          : game === "shogi"
            ? shogiRoomSchema
            : reversiRoomSchema;
    for (const state of states)
      await connect(assignment.roomId, state.assignment!.membership.token);
    now += 5_000;
    const started = schema.parse(await roomStub.getRoom());
    expect(started.settings.timeControl).toEqual({ mainTimeMs, byoyomiMs });
    if (started.status !== "playing") throw Error("Expected playing");
    const turn = started.game.turn;
    expect(started.clock.turnExpiresAt).toBe(now + duration);
    now += duration - 1;
    await evictDurableObject(roomStub);
    const restored = schema.parse(await roomStub.getRoom());
    expect(restored.settings.timeControl).toEqual({ mainTimeMs, byoyomiMs });
    expect(restored.status === "playing" && restored.game.turn).toBe(turn);
    expect(restored.clock?.turnExpiresAt).toBe(now + 1);
    now++;
    await runInDurableObject(roomStub, (instance) => instance.alarm());
    const expired = schema.parse(await roomStub.getRoom());
    if (seats === 4) {
      expect(expired.status).toBe("playing");
      expect(expired.status === "playing" && expired.game.turn).not.toBe(turn);
      expect(expired.clock?.turnExpiresAt).toBe(now + 30_000);
    } else {
      expect(expired.status).toBe("waiting");
      if (game === "shogi")
        expect(shogiRoomSchema.parse(expired).lastRound?.game.eliminations).toEqual([
          expect.objectContaining({ reason: "timeout" }),
        ]);
      else
        expect(
          reversiRoomSchema.parse(expired).lastRound?.replay.steps.at(-1)?.action,
        ).toMatchObject({
          type: "eliminate",
          reason: "timeout",
        });
    }
  },
);

test("変更前に成立した将棋ルームは保存済みの5分＋30秒で開始・復元する", async () => {
  let now = Date.now() + 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const queue = shogiQueue();
  const users = await fixture(2, queue);
  const states = await Promise.all(users.map((u) => queue.status(u.account.id, u.controllerId)));
  const assignment = states[0]!.assignment!;
  rooms.add(assignment.roomId);
  const roomStub = env.GAME_ROOM.getByName(assignment.roomId);
  const timeControl = { mainTimeMs: 300_000, byoyomiMs: 30_000 } as const;
  await runInDurableObject(roomStub, (_, ctx) => {
    const room = shogiRoomSchema.parse(ctx.storage.kv.get("room"));
    room.settings.timeControl = timeControl;
    ctx.storage.kv.put("room", room);
  });
  await evictDurableObject(roomStub);
  for (const state of states) await connect(assignment.roomId, state.assignment!.membership.token);
  now += 5_000;
  const started = shogiRoomSchema.parse(await roomStub.getRoom());
  expect(started.settings.timeControl).toEqual(timeControl);
  if (started.status !== "playing") throw Error("Expected playing");
  expect(started.clock.turnExpiresAt).toBe(now + 330_000);
  await evictDurableObject(roomStub);
  expect(await roomStub.getRoom()).toMatchObject({
    status: "playing",
    settings: { timeControl },
    clock: { turnExpiresAt: now + 330_000 },
  });
});

test("未接続者の入室期限で旧ルームを閉じ、接続済みの人間を元の優先度で再割当する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const users = await fixture(4);
  const states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
  const old = states[0]!.assignment!;
  rooms.add(old.roomId);
  for (const s of states.slice(0, 3)) await connect(old.roomId, s.assignment!.membership.token);
  now += rules.connectionGraceMs;
  await runInDurableObject(stub(), (instance) => instance.alarm());
  expect(await env.GAME_ROOM.getByName(old.roomId).getRoom()).toBeNull();
  expect((await stub().status(users[3]!.account.id, users[3]!.controllerId)).status).toBe("idle");
  const restored = await Promise.all(
    users.slice(0, 3).map((u) => stub().status(u.account.id, u.controllerId)),
  );
  for (let i = 0; i < 3; i++) {
    expect(restored[i]!.status).toBe("matched");
    expect(restored[i]!.operationId).toBe(states[i]!.operationId);
    expect(restored[i]!.joinedAtMs).toBe(states[i]!.joinedAtMs);
    expect(restored[i]!.assignment!.matchId).not.toBe(old.matchId);
    rooms.add(restored[i]!.assignment!.roomId);
  }
  expect(new Set(restored.map((s) => s.assignment!.matchId)).size).toBe(1);
});

test("対局中に資格更新が中断しても再起動後のAlarmで復旧し、旧資格を拒否する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const users = await fixture(4),
    states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
  const a = states[0]!.assignment!;
  rooms.add(a.roomId);
  const room = env.GAME_ROOM.getByName(a.roomId);
  for (const s of states) await connect(a.roomId, s.assignment!.membership.token);
  now += 5000;
  expect(roomSchema.parse(await room.getRoom()).status).toBe("playing");
  await runInDurableObject(stub(), (instance) => instance.alarm());
  // 資格の新世代を永続化した直後、ルームへ届ける前の中断地点から復旧します。
  const controllerId = crypto.randomUUID();
  await runInDurableObject(stub(), async (_, state) => {
    const value = state.storage.kv.get<any>("state");
    const player = value.groups[0].players[0];
    player.controllerId = controllerId;
    player.version++;
    player.credentialPending = true;
    player.tokenHash = (await matchmakingCredential(env, player)).tokenHash;
    state.storage.kv.put("state", value);
  });
  await evictDurableObject(stub());
  expect((await stub().status(users[0]!.account.id, controllerId)).assignment).toBeUndefined();
  await runInDurableObject(stub(), (instance) => instance.alarm());
  const recovered = await stub().status(users[0]!.account.id, controllerId);
  expect(recovered.status).toBe("playing");
  expect(recovered.assignment).toBeDefined();
  expect(recovered.assignment!.membership.token).not.toBe(a.membership.token);
  expect(
    await runInDurableObject(room, (_, state) => state.storage.getAlarm()),
  ).toBeLessThanOrEqual(now + 30000);
  await expect(connect(a.roomId, a.membership.token)).rejects.toThrow();
  await connect(a.roomId, recovered.assignment!.membership.token);
  expect(
    (await stub().status(users[0]!.account.id, users[0]!.controllerId)).assignment,
  ).toBeUndefined();
  const credentials = states.map((s, i) =>
    i === 0 ? recovered.assignment!.membership.token : s.assignment!.membership.token,
  );
  for (const token of credentials) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    await room.leaveRoom(
      Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(""),
    );
  }
  await stub().cleanupReleasedGroups();
  for (const u of users)
    expect((await stub().status(u.account.id, u.controllerId)).status).toBe("idle");
  expect(
    await runInDurableObject(
      stub(),
      (_, state) => state.storage.kv.get<any>("state").groups.length,
    ),
  ).toBe(0);
});

test("入室後の操作元切替は開始予告を取り消し、全員の再接続から5秒を数え直す", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const users = await fixture(4),
    states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
  const a = states[0]!.assignment!;
  rooms.add(a.roomId);
  const room = env.GAME_ROOM.getByName(a.roomId);
  for (const s of states) await connect(a.roomId, s.assignment!.membership.token);
  const initial = roomSchema.parse(await room.getRoom());
  expect("matchmaking" in initial && initial.matchmaking?.startsAtMs).toBe(now + 5000);
  now += 1000;
  const transfer = await stub().takeover(
    users[0]!.account.id,
    users[0]!.operationId,
    crypto.randomUUID(),
    1,
  );
  expect(transfer.ok).toBe(true);
  if (!transfer.ok) throw Error("引継ぎ");
  const waiting = roomSchema.parse(await room.getRoom());
  expect("matchmaking" in waiting && waiting.matchmaking?.startsAtMs).toBeUndefined();
  expect(transfer.state.assignment!.expiresAtMs).toBe(a.expiresAtMs);
  await connect(a.roomId, transfer.state.assignment!.membership.token);
  const reconnected = roomSchema.parse(await room.getRoom());
  expect("matchmaking" in reconnected && reconnected.matchmaking?.startsAtMs).toBe(now + 5000);
});

test("全員の接続後だけカウントダウンし、再起動しても1回だけ開始する", async () => {
  fixTestTime();
  const usage = recordUsageEvents();
  const users = await fixture(4);
  const states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
  const a = states[0]!.assignment!;
  rooms.add(a.roomId);
  const roomStub = env.GAME_ROOM.getByName(a.roomId);
  for (const s of states.slice(0, 3)) await connect(a.roomId, s.assignment!.membership.token);
  let room = roomSchema.parse(await roomStub.getRoom());
  expect(room.status).toBe("waiting");
  if (room.settings.game !== "four-reversi") throw Error("game");
  expect("matchmaking" in room && room.matchmaking?.startsAtMs).toBeUndefined();
  await connect(a.roomId, states[3]!.assignment!.membership.token);
  room = roomSchema.parse(await roomStub.getRoom());
  expect(room.status).toBe("waiting");
  expect("matchmaking" in room && room.matchmaking?.startsAtMs).toBeGreaterThan(Date.now());
  await runInDurableObject(roomStub, async (_instance, state) => {
    const r = roomSchema.parse(state.storage.kv.get("room"));
    if (!("matchmaking" in r) || !r.matchmaking) throw Error("metadata");
    r.matchmaking.startsAtMs = Date.now() - 1;
    state.storage.kv.put("room", r);
  });
  await evictDurableObject(roomStub);
  const playing = roomSchema.parse(await roomStub.getRoom());
  expect(playing.status).toBe("playing");
  expect(playing.clock?.remainingMainMs).toBeDefined();
  expect((await roomStub.getMatchmakingState(a.matchId, a.instanceId)).started).toBe(true);
  const savedReservation = await runInDurableObject(roomStub, (_, ctx) =>
    ctx.storage.kv.get<{ players: { search?: unknown }[] }>(`matchmaking:${a.matchId}`)!,
  );
  expect(savedReservation.players.every((p) => p.search === undefined)).toBe(true);

  await vi.waitFor(async () =>
    expect(
      usage
        .filter((e) => e.name === "matchmaking")
        .filter((e) => e.operationId === users[0]!.operationId)
        .map((e) => e.stage),
    ).toEqual(["accepted", "matched", "started"]),
  );

  expect((await roomStub.abortMatchmakingRoom(a.matchId, a.instanceId)).status).toBe(
    "already_started",
  );
  expect(
    (
      await stub().control(
        users[0]!.account.id,
        { operationId: users[0]!.operationId, controllerId: users[0]!.controllerId, version: 1 },
        "cancel",
      )
    ).ok,
  ).toBe(false);
  expect((await stub().status(users[0]!.account.id, users[0]!.controllerId)).status).toBe(
    "playing",
  );
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM matchmaking_wait_reservations WHERE account_id=?")
      .bind(users[0]!.account.id)
      .first(),
  ).toBeNull();
});

test.each(["four-shogi", "four-reversi", "shogi", "reversi"] as const)(
  "%sのCPU補充局は公開番号を保持し、再取得・DO再起動で再採番しない",
  async (game) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    const [user] = await fixture(1, queue);
    await runInDurableObject(queue, (_, ctx) => {
      const state = ctx.storage.kv.get<{ waiting: { joinedAtMs: number }[] }>("state")!;
      state.waiting[0]!.joinedAtMs = Date.now() - 60000;
      ctx.storage.kv.put("state", state);
    });
    // 番号の検証は成立後を対象とし、準備が自動再試行された場合は保存済みの期限で進めます。
    for (let attempt = 0; attempt < 3; attempt++) {
      await runInDurableObject(queue, (instance) => instance.alarm());
      if ((await queue.status(user!.account.id, user!.controllerId)).status !== "waiting") break;
      const retryAt = await runInDurableObject(queue, (_, ctx) => {
        const state = ctx.storage.kv.get<{
          waiting: { retryAtMs?: number }[];
          cpuRetryAtMs?: number;
        }>("state")!;
        const retry = state.waiting[0]?.retryAtMs;
        return retry === undefined ? undefined : Math.max(retry, state.cpuRetryAtMs ?? 0);
      });
      expect(retryAt).toBeTypeOf("number");
      now = Math.max(now + 1, retryAt! + 1);
    }
    const matched = await queue.status(user!.account.id, user!.controllerId);
    expect(matched.status).toBe("matched");
    const assignment = matched.assignment!;
    rooms.add(assignment.roomId);
    const room = env.GAME_ROOM.getByName(assignment.roomId);
    expect(roomSchema.parse(await room.getRoom()).players.some((p) => p.kind === "cpu")).toBe(true);
    const read = async () => {
      let cursor: string | null = null;
      do {
        const path =
          `/lobby/rooms?view=cards&game=${game}&includeMatchKind=1&includeMatchSequence=1` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const response = await exports.default.fetch(
          new AcceptedGameRequest(`${origin}/api${path}`),
        );
        expect(response.status).toBe(200);
        const result = (await response.json()) as {
          rooms: { id: string; matchSequence?: number }[];
          nextCursor: string | null;
        };
        const entry = result.rooms.find((entry) => entry.id === assignment.roomId);
        if (entry) return entry.matchSequence;
        cursor = result.nextCursor;
      } while (cursor !== null);
      throw new Error("Prepared room missing from lobby");
    };
    const sequence = await read();
    expect(sequence).toBeGreaterThan(0);
    await evictDurableObject(queue);
    await evictDurableObject(room);
    expect((await queue.status(user!.account.id, user!.controllerId)).assignment?.matchId).toBe(
      assignment.matchId,
    );
    expect(await read()).toBe(sequence);
    expect(await room.getPublicMetadata()).not.toHaveProperty("matchSequence");
  },
);
