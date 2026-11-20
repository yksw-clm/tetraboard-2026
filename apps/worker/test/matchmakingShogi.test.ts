import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  shogiMatchmakingRules,
  ratedCpuNames,
  getPublicMatchContract,
  shogiRoomSchema,
} from "@tetraboard/protocol";
import { origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { selectShogiCpu, shogiCpuProfile } from "@tetraboard/context-matchmaking";
import {
  selectReversiCpu,
  reversiCpuProfile,
} from "../src/adapters/matchmaking/reversiCpuProfiles";
import { matchmakingCredential } from "../src/adapters/matchmaking/credential";
import type { ShogiCpuJob } from "../src/adapters/room/games/shogi/progress";
import {
  useMatchmakingFixtures,
  shogiQueue,
  rooms,
  fixture,
  connect,
  ratedAccount,
} from "./matchmakingFixtures";

useMatchmakingFixtures();

test("通常将棋と通常リバーシは各基準レートに対応するCPU名を選ぶ", () => {
  for (const [rating, name] of [
    [1365, "フミ"],
    [1403, "ヤリ"],
    [1488, "ケイ"],
    [1552, "ギン"],
    [1778, "リュウ"],
  ] as const) {
    const source = selectShogiCpu(rating);
    if (source.kind !== "cpu") throw Error("Expected CPU");
    const profile = shogiCpuProfile(source.profileId);
    expect(profile?.standardBook && ratedCpuNames.shogi[profile.nodes]).toBe(name);
  }
  for (const [rating, name] of [
    [1297, "パチ"],
    [1490, "クルリ"],
    [1748, "カエシ"],
    [2109, "セキ"],
    [2385, "フチ"],
    [2650, "シメ"],
    [3003, "クロシロ"],
  ] as const) {
    expect(reversiCpuProfile(selectReversiCpu(rating))?.name).toBe(name);
  }
});

test("保存済みの将棋レートを引き継ぎ、単独待機は15秒でCPU戦になる", async () => {
  let now = Date.now() + 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const account = await ratedAccount(1764.125, 5);
  const queue = shogiQueue();
  const controllerId = crypto.randomUUID();
  const rating = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/shogi/rating`, {
      headers: account.headers,
    }),
  );
  expect(rating.status).toBe(200);
  expect(await rating.json()).toEqual({ status: "rated", rating: 1764.125 });

  const joined = await queue.join(account.id, crypto.randomUUID(), controllerId);
  expect(joined).toMatchObject({ ok: true, state: { status: "waiting" } });
  now += 14_999;
  await runInDurableObject(queue, (instance) => instance.alarm());
  expect(await queue.status(account.id, controllerId)).toMatchObject({ status: "waiting" });
  expect(await runInDurableObject(queue, (_, ctx) => ctx.storage.getAlarm())).toBe(now + 1);

  now++;
  await runInDurableObject(queue, (instance) => instance.alarm());
  const matched = await queue.status(account.id, controllerId);
  expect(matched).toMatchObject({ status: "matched", assignment: { opponent: "cpu" } });
  const assignment = matched.assignment!;
  rooms.add(assignment.roomId);
  const room = env.GAME_ROOM.getByName(assignment.roomId);
  const reservation = await runInDurableObject(room, (_, ctx) =>
    ctx.storage.kv.get(`matchmaking:${assignment.matchId}`),
  );
  expect(reservation).toMatchObject({
    rating: {
      kind: "cpu",
      profileId: "yaneuraou-material-faeb37f0-n1024-standard-book-v1",
      referenceRating: 1778,
    },
  });
});

test.each([
  { difference: 101, deadline: 5000, opponent: "human" },
  { difference: 201, deadline: 10000, opponent: "human" },
  { difference: 250, deadline: 15000, opponent: "human" },
  { difference: 301, deadline: 15000, opponent: "cpu" },
])(
  "将棋の待機幅とCPUへの切替を照合する ($difference, $deadline)",
  async ({ difference, deadline, opponent }) => {
    let now = Date.now() + 60000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = shogiQueue();
    const [[oldest], other] = await Promise.all([
      fixture(1, queue),
      ratedAccount(1500 + difference),
    ]);
    const joinedAt = now;
    now += 1000;
    const control = crypto.randomUUID();
    expect((await queue.join(other.id, crypto.randomUUID(), control)).ok).toBe(true);
    now = joinedAt + (difference === 250 ? 10000 : deadline) - 1;
    await runInDurableObject(queue, (instance) => instance.alarm());
    expect(await runInDurableObject(queue, (_, ctx) => ctx.storage.getAlarm())).toBe(now + 1);
    expect((await queue.status(oldest!.account.id, oldest!.controllerId)).status).toBe("waiting");
    now = joinedAt + deadline;
    await runInDurableObject(queue, (instance) => instance.alarm());
    const matched = (await queue.status(oldest!.account.id, oldest!.controllerId)).assignment!;
    rooms.add(matched.roomId);
    const room = shogiRoomSchema.parse(await env.GAME_ROOM.getByName(matched.roomId).getRoom());
    expect(room.matchmaking?.opponent).toBe(opponent);
    expect(room.settings.timeControl).toEqual(shogiMatchmakingRules.timeControl);
    const second = await queue.status(other.id, control);
    if (opponent === "human") expect(second.assignment?.matchId).toBe(matched.matchId);
    else expect(second.status).toBe("waiting");
  },
);

test("将棋は先頭がCPU枠を待っていても後続の対人成立を進める", async () => {
  let now = Date.now() + 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const queue = shogiQueue();
  const oldest = await ratedAccount(1100);
  const controllerId = crypto.randomUUID();
  const joinedAtMs = now;
  expect(await queue.join(oldest.id, crypto.randomUUID(), controllerId)).toMatchObject({
    ok: true,
    state: { status: "waiting", waitingCount: 5 },
  });

  now += shogiMatchmakingRules.fillAfterMs;
  await runInDurableObject(queue, (_, ctx) => {
    ctx.storage.kv.put("state", {
      ...ctx.storage.kv.get<object>("state"),
      cpuRetryAtMs: now + 2000,
    });
  });
  const [first, second] = await fixture(2, queue);
  const state = await queue.status(first!.account.id, first!.controllerId);
  expect(state).toMatchObject({ status: "matched", assignment: { opponent: "human" } });
  rooms.add(state.assignment!.roomId);
  expect((await queue.status(second!.account.id, second!.controllerId)).assignment?.matchId).toBe(
    state.assignment!.matchId,
  );
  expect(await queue.status(oldest.id, controllerId)).toMatchObject({
    status: "waiting",
    joinedAtMs,
    waitingCount: 5,
  });
});

test("将棋の対人マッチは認証接続後だけ開始し、終局で両者のレートを保存する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const queue = shogiQueue();
  const users = await fixture(2, queue);
  const assignments = await Promise.all(
    users.map(async (u) => (await queue.status(u.account.id, u.controllerId)).assignment!),
  );
  const first = assignments[0]!;
  rooms.add(first.roomId);
  const room = env.GAME_ROOM.getByName(first.roomId);
  await connect(first.roomId, first.membership.token);
  now += 5000;
  expect(shogiRoomSchema.parse(await room.getRoom()).matchmaking?.startsAtMs).toBeUndefined();
  await connect(first.roomId, assignments[1]!.membership.token);
  const waiting = shogiRoomSchema.parse(await room.getRoom());
  expect(waiting.matchmaking?.startsAtMs).toBe(now + 5000);
  now += 5000;
  const started = shogiRoomSchema.parse(await room.getRoom());
  if (started.status !== "playing") throw Error("Expected playing");
  expect(started.roundId).toBe(first.matchId);
  expect(started.clock.turnExpiresAt).toBe(now + 600_000);
  const credential = await matchmakingCredential(
    env,
    {
      accountId: users[0]!.account.id,
      operationId: users[0]!.operationId,
      controllerId: users[0]!.controllerId,
      version: 1,
      joinedAtMs: 0,
      expiresAtMs: 0,
      sequence: 0,
    },
    shogiMatchmakingRules.key,
  );
  expect(await room.leaveRoom(credential.tokenHash)).toBe("left");
  const seats = () =>
    env.APP_DB.prepare("SELECT 1 FROM account_room_seats WHERE account_id=?")
      .bind(users[0]!.account.id)
      .first();
  await vi.waitFor(async () => expect(await seats()).toBeNull());
  const nextOperation = crypto.randomUUID();
  expect(
    await queue.join(users[0]!.account.id, nextOperation, users[0]!.controllerId),
  ).toMatchObject({
    ok: false,
    message: expect.stringContaining("保存中"),
  });
  await vi.waitFor(async () =>
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM match_uploads WHERE id=?")
        .bind(first.matchId)
        .first(),
    ).toBeTruthy(),
  );
  const changes = () =>
    env.APP_DB.prepare(
      "SELECT account_id,rating_after,rated_games,human_games FROM elo_rating_changes WHERE game='shogi' AND match_id=?",
    )
      .bind(first.matchId)
      .all();
  await vi.waitFor(async () => {
    now++;
    await room.getRoom();
    expect((await changes()).results).toHaveLength(2);
  });
  expect((await changes()).results).toEqual(
    expect.arrayContaining([
      { account_id: users[0]!.account.id, rating_after: 1468, rated_games: 1, human_games: 1 },
      { account_id: users[1]!.account.id, rating_after: 1532, rated_games: 1, human_games: 1 },
    ]),
  );
  expect((await queue.join(users[0]!.account.id, nextOperation, users[0]!.controllerId)).ok).toBe(
    true,
  );
  expect(
    await runInDurableObject(
      queue,
      (_, ctx) =>
        ctx.storage.kv.get<{ waiting: { rating: number }[] }>("state")?.waiting[0]?.rating,
    ),
  ).toBe(1468);
});

test("将棋CPU戦は選んだ探索予算で着手し、そのCPU基準レートで結果を保存する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const queue = shogiQueue();
  const account = await ratedAccount(1778);
  const operationId = crypto.randomUUID();
  const controllerId = crypto.randomUUID();
  expect((await queue.join(account.id, operationId, controllerId)).ok).toBe(true);
  now += 15000;
  await runInDurableObject(queue, (instance) => instance.alarm());
  const assignment = (await queue.status(account.id, controllerId)).assignment!;
  rooms.add(assignment.roomId);
  const room = env.GAME_ROOM.getByName(assignment.roomId);
  const socket = await connect(assignment.roomId, assignment.membership.token);
  now += 5000;
  const started = shogiRoomSchema.parse(await room.getRoom());
  if (started.status !== "playing") throw Error("Expected playing");
  expect(started.matchmaking?.opponent).toBe("cpu");
  expect(started.players.find((player) => player.kind === "cpu")?.name).toBe("リュウ");
  const humanSide =
    started.game.players.south === assignment.membership.playerId ? "south" : "north";
  if (humanSide === "south")
    socket.send(
      JSON.stringify({
        type: "room.game.action",
        roundId: started.roundId,
        positionRevision: started.positionRevision,
        action: started.legalActions[0],
      }),
    );
  const cpuPly = humanSide === "south" ? 1 : 0;
  await vi.waitFor(async () =>
    expect(shogiRoomSchema.parse(await room.getRoom()).game?.moveNumber).toBe(cpuPly),
  );
  now += 2000;
  const fetchAi = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const input = JSON.parse(String(init?.body));
    return Response.json({
      request_id: input.request_id,
      position_revision: input.position_revision,
      engine_version: "yaneuraou-material-faeb37f0",
      nodes: input.nodes,
      opening_book: input.opening_book,
      best_move: humanSide === "south" ? "3c3d" : "7g7f",
    });
  });
  await runInDurableObject(room, async (instance, ctx) => {
    const original = Reflect.get(instance, "env");
    Reflect.set(instance, "env", {
      ...original,
      AI_SHOGI_ENABLED: "true",
      AI_SERVICE_URL: "https://ai.example.test",
      AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
    });
    try {
      await instance.alarm();
      expect(fetchAi).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchAi.mock.calls[0]?.[1]?.body))).toMatchObject({
        nodes: 1024,
        opening_book: "standard-v1",
      });
      const job = ctx.storage.kv.get<ShogiCpuJob>("standard-shogi-cpu-job")!;
      expect(job.external).toBe(true);
      now = job.applyAt;
      await instance.alarm();
    } finally {
      Reflect.set(instance, "env", original);
      fetchAi.mockRestore();
    }
  });
  expect(shogiRoomSchema.parse(await room.getRoom()).game?.moveNumber).toBe(cpuPly + 1);
  socket.send(JSON.stringify({ type: "room.game.resign" }));
  await vi.waitFor(async () => {
    now++;
    const finished = shogiRoomSchema.parse(await room.getRoom());
    if (finished.status !== "waiting") throw Error("Expected finished game");
    expect(finished.lastRound?.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "リュウ",
          appearance: { kind: "cpu", level: 2, name: "リュウ" },
        }),
      ]),
    );
    expect(
      await env.APP_DB.prepare(
        "SELECT rating_before,rating_after,rated_games,human_games FROM elo_rating_changes WHERE game='shogi' AND match_id=?",
      )
        .bind(assignment.matchId)
        .first(),
    ).toEqual({
      rating_before: 1778,
      rating_after: 1754,
      rated_games: 2,
      human_games: 0,
    });
  });
  const replay = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matches/${assignment.matchId}`),
  );
  expect(replay.status).toBe(200);
  const { match } = getPublicMatchContract.response.parse(await replay.json());
  expect(match.participants.find((player) => player.kind === "cpu")?.name).toBe("リュウ");
  for (const player of match.participants) {
    const query = new URLSearchParams({
      source: "match",
      matchId: match.id,
      playerId: player.id,
      game: "shogi",
      includeRating: "1",
    });
    const response = await exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/player-profile?${query}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rating:
        player.kind === "cpu"
          ? { timing: "reference", status: "rated", rating: 1778 }
          : { timing: "before", status: "placement" },
    });
  }
});

test("将棋の成立前取消は保存待ちを残さず、新しい操作で再参加できる", async () => {
  const queue = shogiQueue();
  const [user] = await fixture(1, queue);
  const { account, operationId, controllerId } = user!;
  expect(
    await queue.control(account.id, { operationId, controllerId, version: 1 }, "cancel"),
  ).toMatchObject({ ok: true, state: { status: "idle" } });
  expect((await queue.join(account.id, crypto.randomUUID(), controllerId)).ok).toBe(true);
});

test.each(["human", "cpu"] as const)(
  "成立した将棋の%s戦は取消と競合しても入室できる",
  async (opponent) => {
    let now = Date.now() + 60000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = shogiQueue();
    const [user] = await fixture(opponent === "human" ? 2 : 1, queue);
    if (opponent === "cpu") {
      expect((await queue.status(user!.account.id, user!.controllerId)).status).toBe("waiting");
      now += shogiMatchmakingRules.fillAfterMs;
    }
    const result = await queue.control(
      user!.account.id,
      { operationId: user!.operationId, controllerId: user!.controllerId, version: 1 },
      "cancel",
    );
    expect(result).toMatchObject({
      ok: true,
      state: { status: "matched", assignment: { opponent } },
    });
    if (!result.ok || !result.state.assignment) throw Error("Expected assignment");
    const { assignment } = result.state;
    rooms.add(assignment.roomId);
    expect(await queue.status(user!.account.id, user!.controllerId)).toMatchObject({
      assignment,
    });
    expect(await env.GAME_ROOM.getByName(assignment.roomId).getRoom()).not.toBeNull();
  },
);
