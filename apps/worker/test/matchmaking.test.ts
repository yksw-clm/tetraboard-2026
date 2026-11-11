import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  matchmakingRules as rules,
  fourReversiRatedMatchmakingRules,
  fourReversiRatingResultSchema,
  matchmakingStateSchema,
  roomSchema,
  shogiMatchmakingRules,
  reversiMatchmakingRules,
  reversiRoomSchema,
  ratedCpuNames,
  getPublicMatchContract,
  shogiRoomSchema,
  matchmakingQueues,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/reversi";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { selectShogiCpu, shogiCpuProfile } from "../src/matchmaking/shogiCpuProfiles";
import { selectReversiCpu, reversiCpuProfile } from "../src/matchmaking/reversiCpuProfiles";
import { selectFourReversi } from "../src/matchmaking/fourReversiSelection";
import { matchmakingCredential } from "../src/matchmaking/coordinator";
import { requestDeletion } from "../src/privacy/deletion";
import { requireGuestIdle } from "../src/accounts/guestLinking";
import { accountIdentity } from "../src/accounts/auth";
import { matchmakingRoutes } from "../src/matchmaking/routes";
import { standardShogiRecord, saveStandardShogiFixture } from "./standardShogiFixtures";
import { reversiMatchData } from "../src/accounts/reversiMatchData";
import { writeMatch } from "../src/rooms/matchStore";
import type { ShogiCpuJob } from "../src/rooms/standardShogiProgress";
import { CpuCapacity } from "../src/rooms/cpuCapacity";
const stub = () => env.MATCHMAKING_COORDINATOR.getByName(rules.key);
const fourRatedQueue = () =>
  env.MATCHMAKING_COORDINATOR.getByName(fourReversiRatedMatchmakingRules.key);
const shogiQueue = () => env.MATCHMAKING_COORDINATOR.getByName(shogiMatchmakingRules.key);
const reversiQueue = () => env.MATCHMAKING_COORDINATOR.getByName(reversiMatchmakingRules.key);
const accounts: string[] = [];
const rooms = new Set<string>();
const sockets: WebSocket[] = [];
test("閲覧だけでゲストを作らず、名前確定したゲストは登録者と同じ列で参加できる", async () => {
  const count = () =>
    env.APP_DB.prepare("SELECT COUNT(*) AS n FROM user WHERE isAnonymous=1").first<{ n: number }>();
  const before = await count();
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/four-reversi`),
  );
  expect(response.status).toBe(200);
  expect((await count())?.n).toBe(before?.n);
  const registered = (await fixture(1))[0]!;
  const guest = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/account/guest`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "CF-Connecting-IP": crypto.randomUUID(),
      },
      body: JSON.stringify({ name: "ゲスト参加者" }),
    }),
  );
  expect(guest.status).toBe(201);
  const cookie = guest.headers
    .getSetCookie()
    .find((c) => c.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const user = await accountIdentity(new Request(origin, { headers: { Cookie: cookie } }), env);
  expect(user?.guestNameCustomized).toBeTruthy();
  accounts.push(user!.id);
  const rated = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/shogi/join`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    }),
  );
  expect(rated.status).toBe(403);
  expect(await rated.text()).toContain("登録アカウントが必要");
  const summary = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/shogi/rating`, {
      headers: { Cookie: cookie },
    }),
  );
  expect(summary.status).toBe(401);
  const operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  expect((await stub().join(user!.id, operationId, controllerId)).ok).toBe(true);
  await fill();
  const matched = await stub().status(user!.id, controllerId);
  rooms.add(matched.assignment!.roomId);
  const room = roomSchema.parse(
    await env.GAME_ROOM.getByName(matched.assignment!.roomId).getRoom(),
  );
  expect(room.players.find((p) => p.name === "ゲスト参加者")).toMatchObject({
    kind: "human",
    isGuest: true,
  });
  expect(
    (await stub().status(registered.account.id, registered.controllerId)).assignment?.matchId,
  ).toBe(matched.assignment!.matchId);
});
async function fixture(count: number, queue = stub()) {
  const users = [];
  for (let i = 0; i < count; i++) {
    const account = await accountFixture();
    accounts.push(account.id);
    users.push({ account, operationId: crypto.randomUUID(), controllerId: crypto.randomUUID() });
  }
  for (const user of users) {
    const result = await queue.join(user.account.id, user.operationId, user.controllerId);
    expect(result.ok).toBe(true);
  }
  return users;
}
async function fill() {
  await runInDurableObject(stub(), async (_instance, state) => {
    const current = state.storage.kv.get<{ waiting: { joinedAtMs: number }[] }>("state")!;
    for (const w of current.waiting) w.joinedAtMs = Date.now() - rules.fillAfterMs - 100;
    state.storage.kv.put("state", current);
  });
  await runInDurableObject(stub(), (instance) => instance.alarm());
}
async function connect(id: string, token: string) {
  const r = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/rooms/${id}/ws`, { headers: { Upgrade: "websocket" } }),
  );
  expect(r.status).toBe(101);
  const socket = r.webSocket!;
  socket.accept();
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (e) => {
      const v = JSON.parse(String(e.data));
      if (v.type === "room.authenticated") resolve();
      if (v.type === "room.error") reject(Error(v.error));
    });
    socket.send(JSON.stringify({ type: "room.auth", token }));
  });
  return socket;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets.splice(0)) s.close();
  for (const id of rooms) {
    await runInDurableObject(env.GAME_ROOM.getByName(id), async (_instance, state) => {
      await state.storage.deleteAll();
    });
  }
  rooms.clear();
  for (const id of accounts.splice(0)) {
    await env.APP_DB.prepare("DELETE FROM shogi_rating_pending WHERE account_id=?").bind(id).run();
    await env.APP_DB.prepare("DELETE FROM reversi_rating_pending WHERE account_id=?")
      .bind(id)
      .run();
    await env.APP_DB.prepare("DELETE FROM four_reversi_rating_pending WHERE account_id=?")
      .bind(id)
      .run();
    await env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?")
      .bind(id)
      .run();
    await env.APP_DB.prepare("DELETE FROM matchmaking_wait_reservations WHERE account_id=?")
      .bind(id)
      .run();
    await env.APP_DB.prepare(
      "DELETE FROM room_avatar_refs WHERE operation_id IN(SELECT operation_id FROM account_room_seats WHERE account_id=?)",
    )
      .bind(id)
      .run();
    await env.APP_DB.prepare("DELETE FROM account_room_seats WHERE account_id=?").bind(id).run();
  }
  for (const queue of [
    stub(),
    ...Object.values(matchmakingQueues).map(({ key }) =>
      env.MATCHMAKING_COORDINATOR.getByName(key),
    ),
  ])
    await runInDurableObject(queue, async (_instance, state) => {
      await state.storage.deleteAll();
    });
  for (const game of Object.keys(matchmakingQueues))
    await runInDurableObject(env.CPU_CAPACITY.getByName(game), (_, ctx) => ctx.storage.deleteAll());
});

test.each([
  { game: "four-shogi", empty: 12, occupied: 9 },
  { game: "four-reversi", empty: 12, occupied: 9 },
  { game: "shogi", empty: 4, occupied: 3 },
  { game: "reversi", empty: 4, occupied: 3 },
] as const)(
  "$gameの待機人数は実際に予約できるCPU枠と人間を加算する",
  async ({ game, empty, occupied }) => {
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    const capacity = env.CPU_CAPACITY.getByName(game);
    expect((await queue.status(null)).waitingCount).toBe(empty);
    const [user] = await fixture(1, queue);
    expect((await queue.status(user!.account.id, user!.controllerId)).waitingCount).toBe(empty + 1);
    // 通常対局や開始待ちも同じ予約台帳を占有します。
    expect(await capacity.reserve("99990", 1, 1)).toBe(true);
    expect((await queue.status(null)).waitingCount).toBe(occupied + 1);
    for (const roomId of ["99991", "99992", "99993"])
      expect(await capacity.reserve(roomId, 1, 1)).toBe(true);
    expect((await queue.status(null)).waitingCount).toBe(1);
    await capacity.release("99990", 1);
    expect((await queue.status(null)).waitingCount).toBe(empty - occupied + 1);
  },
);

test.each(["four-shogi", "four-reversi"] as const)(
  "%sは人間2人なら14人、満枠で人間3人なら3人になり、期限切れと成立済みを除く",
  async (game) => {
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    const users = await fixture(2, queue);
    expect((await queue.status(null)).waitingCount).toBe(14);
    const [third] = await fixture(1, queue);
    const capacity = env.CPU_CAPACITY.getByName(game);
    for (let i = 0; i < 4; i++) await capacity.reserve(`9999${i}`, 1, 3);
    expect((await queue.status(null)).waitingCount).toBe(3);
    await runInDurableObject(queue, (_, ctx) => {
      const state = ctx.storage.kv.get<{ waiting: { accountId: string; expiresAtMs: number }[] }>(
        "state",
      )!;
      state.waiting.find((wait) => wait.accountId === third!.account.id)!.expiresAtMs = Date.now();
      ctx.storage.kv.put("state", state);
    });
    expect((await queue.status(null)).waitingCount).toBe(2);
    // 予約解放後に4人で成立しても、人間のみの対局はCPU枠を消費しません。
    for (let i = 0; i < 4; i++) await capacity.release(`9999${i}`, 1);
    const next = await fixture(2, queue);
    const matched = await queue.status(users[0]!.account.id, users[0]!.controllerId);
    expect(matched.status).toBe("matched");
    rooms.add(matched.assignment!.roomId);
    expect(matched.waitingCount).toBe(12);
    expect((await queue.status(next[0]!.account.id, next[0]!.controllerId)).waitingCount).toBe(12);
  },
);

test("受付確認のみのGETはCPU枠を照会せず、枠取得失敗でも検索・取消を継続して次の取得で回復する", async () => {
  const account = await accountFixture();
  accounts.push(account.id);
  const read = vi.spyOn(CpuCapacity.prototype, "availableSeats").mockImplementation(() => {
    throw new Error("capacity unavailable");
  });
  const request = (count: boolean) =>
    matchmakingRoutes.request(
      new AcceptedGameRequest(`${origin}/matchmaking/shogi${count ? "?waitingCount=1" : ""}`, {
        headers: account.headers,
      }),
      undefined,
      {
        ...env,
        APP_ORIGIN: origin,
        SHOGI_MATCHMAKING_ENABLED: "true",
        AI_SHOGI_ENABLED: "true",
        AI_SERVICE_URL: "https://ai.example.test",
        AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
      },
    );
  const availability = await request(false);
  expect(availability.status).toBe(200);
  expect(await availability.json()).toMatchObject({ status: "idle", enabled: true });
  expect(read).not.toHaveBeenCalled();
  const failed = await request(true);
  expect(failed.status).toBe(200);
  expect(await failed.json()).not.toHaveProperty("waitingCount");
  expect(read).toHaveBeenCalledTimes(1);
  const queue = shogiQueue();
  const operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  const joined = await queue.join(account.id, operationId, controllerId);
  expect(joined).toMatchObject({ ok: true, state: { status: "waiting" } });
  if (!joined.ok) throw new Error("join failed");
  expect(joined.state).not.toHaveProperty("waitingCount");
  expect(joined.state).not.toHaveProperty("estimatedMatchAtMs");
  const cancelled = await queue.control(
    account.id,
    { operationId, controllerId, version: joined.state.version! },
    "cancel",
  );
  expect(cancelled).toMatchObject({ ok: true, state: { status: "idle" } });
  read.mockRestore();
  const recovered = await request(true);
  expect(await recovered.json()).toMatchObject({ waitingCount: 4 });
  expect((await stub().status(null)).waitingCount).toBeUndefined();
});

test.each(["four-shogi", "four-reversi", "shogi", "reversi"] as const)(
  "%sの目安は固定の補充時刻で、満枠・期限超過では省略し、旧APIへ追加しない",
  async (game) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    const [user] = await fixture(1, queue);
    const at = now + matchmakingQueues[game].fillAfterMs;
    const status = () => queue.status(user!.account.id, user!.controllerId);
    expect((await status()).estimatedMatchAtMs).toBe(at);
    expect((await queue.status(null)).estimatedMatchAtMs).toBeUndefined();
    expect(
      (await queue.status(user!.account.id, crypto.randomUUID())).estimatedMatchAtMs,
    ).toBeUndefined();
    const before = await runInDurableObject(queue, (_, ctx) => ctx.storage.kv.get("state"));
    now += 5000;
    expect((await status()).estimatedMatchAtMs).toBe(at);
    expect(await runInDurableObject(queue, (_, ctx) => ctx.storage.kv.get("state"))).toEqual(
      before,
    );
    const request = async (query: string, action?: "heartbeat") => {
      const response = await matchmakingRoutes.request(
        new AcceptedGameRequest(
          `${origin}/matchmaking/${game}${action ? `/${action}` : ""}?rated=1&controllerId=${user!.controllerId}${query}`,
          {
            headers: user!.account.headers,
            ...(action
              ? {
                  method: "POST",
                  body: JSON.stringify({
                    operationId: user!.operationId,
                    controllerId: user!.controllerId,
                    version: 1,
                  }),
                }
              : {}),
          },
        ),
        undefined,
        {
          ...env,
          APP_ORIGIN: origin,
          SHOGI_MATCHMAKING_ENABLED: "true",
          REVERSI_MATCHMAKING_ENABLED: "true",
          FOUR_SHOGI_MATCHMAKING_ENABLED: "true",
          MATCHMAKING_ENABLED: "true",
          AI_SHOGI_ENABLED: "true",
          AI_REVERSI_ENABLED: "true",
          AI_SERVICE_URL: "https://ai.example.test",
          AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await request("&waitingCount=1")).not.toHaveProperty("estimatedMatchAtMs");
    expect(await request("&estimate=1")).toMatchObject({ estimatedMatchAtMs: at });
    expect(await request("&estimate=1")).not.toHaveProperty("waitingCount");
    expect(await request("&estimate=1", "heartbeat")).toMatchObject({ estimatedMatchAtMs: at });
    expect(await request("", "heartbeat")).not.toHaveProperty("estimatedMatchAtMs");
    const capacity = env.CPU_CAPACITY.getByName(game);
    for (let i = 0; i < 4; i++) await capacity.reserve(`9999${i}`, 1, 1);
    expect((await status()).estimatedMatchAtMs).toBeUndefined();
    await capacity.release("99990", 1);
    expect((await status()).estimatedMatchAtMs).toBe(at);
    now = at;
    expect((await status()).estimatedMatchAtMs).toBeUndefined();
  },
);

test.each(["four-shogi", "four-reversi"] as const)(
  "%sの後続の人は先頭の補充時刻を使い、期限切れと再試行待ちを除外する",
  async (game) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    const [first] = await fixture(1, queue);
    const at = now + 20_000;
    now += 8000;
    const [second] = await fixture(1, queue);
    const status = () => queue.status(second!.account.id, second!.controllerId);
    expect((await status()).estimatedMatchAtMs).toBe(at);
    await runInDurableObject(queue, (_, ctx) => {
      const state = ctx.storage.kv.get<{ waiting: { accountId: string; retryAtMs?: number }[] }>(
        "state",
      )!;
      state.waiting.find((entry) => entry.accountId === first!.account.id)!.retryAtMs =
        Date.now() + 5000;
      ctx.storage.kv.put("state", state);
    });
    expect((await status()).estimatedMatchAtMs).toBe(now + 20_000);
    await runInDurableObject(queue, (_, ctx) => {
      const state = ctx.storage.kv.get<{
        waiting: { accountId: string; expiresAtMs: number; retryAtMs?: number }[];
      }>("state")!;
      const wait = state.waiting.find((entry) => entry.accountId === first!.account.id)!;
      delete wait.retryAtMs;
      wait.expiresAtMs = Date.now();
      ctx.storage.kv.put("state", state);
    });
    expect((await status()).estimatedMatchAtMs).toBe(now + 20_000);
  },
);

test("将棋の後続は本人の補充時刻と先行する組が使用するCPU対局枠を反映する", async () => {
  let now = Date.now() + 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const queue = shogiQueue();
  const first = await ratedAccount(1000),
    second = await ratedAccount(2000);
  const firstController = crypto.randomUUID(),
    secondController = crypto.randomUUID();
  await queue.join(first.id, crypto.randomUUID(), firstController);
  const firstAt = now + 15_000;
  now += 5000;
  await queue.join(second.id, crypto.randomUUID(), secondController);
  const secondAt = now + 15_000;
  const capacity = env.CPU_CAPACITY.getByName("shogi");
  for (let i = 0; i < 3; i++) await capacity.reserve(`9999${i}`, 1, 1);
  expect((await queue.status(first.id, firstController)).estimatedMatchAtMs).toBe(firstAt);
  expect((await queue.status(second.id, secondController)).estimatedMatchAtMs).toBeUndefined();
  await capacity.release("99990", 1);
  expect((await queue.status(second.id, secondController)).estimatedMatchAtMs).toBe(secondAt);
  await runInDurableObject(queue, (_, ctx) => {
    const state = ctx.storage.kv.get<{ cpuRetryAtMs?: number }>("state")!;
    state.cpuRetryAtMs = Date.now() + 2000;
    ctx.storage.kv.put("state", state);
  });
  expect((await queue.status(second.id, secondController)).estimatedMatchAtMs).toBeUndefined();
});

async function ratedAccount(rating: number, ratedGames = 1) {
  const account = await accountFixture();
  accounts.push(account.id);
  const previous = standardShogiRecord(account.id, "win", true);
  await saveStandardShogiFixture(previous);
  await env.APP_DB.prepare("INSERT INTO shogi_rating_changes VALUES (?,?,1500,?,?,0)")
    .bind(previous.record.id, account.id, rating, ratedGames)
    .run();
  return account;
}

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
  expect(started.clock.turnExpiresAt).toBe(now + 330000);
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
      await env.APP_DB.prepare("SELECT 1 FROM shogi_match_uploads WHERE id=?")
        .bind(first.matchId)
        .first(),
    ).toBeTruthy(),
  );
  const changes = () =>
    env.APP_DB.prepare(
      "SELECT account_id,rating_after,rated_games,human_games FROM shogi_rating_changes WHERE match_id=?",
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
        "SELECT rating_before,rating_after,rated_games,human_games FROM shogi_rating_changes WHERE match_id=?",
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

test("将棋の待機APIは別キューを使い、四人リバーシとの二重待機を拒否する", async () => {
  const [user] = await fixture(1);
  const join = (account: Awaited<ReturnType<typeof accountFixture>>, enabled: "true" | "false") =>
    matchmakingRoutes.request(
      new AcceptedGameRequest(`${origin}/matchmaking/shogi/join`, {
        method: "POST",
        headers: account.headers,
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          controllerId: crypto.randomUUID(),
        }),
      }),
      undefined,
      {
        ...env,
        APP_ORIGIN: origin,
        SHOGI_MATCHMAKING_ENABLED: enabled,
        AI_SHOGI_ENABLED: "true",
        AI_SERVICE_URL: "https://ai.example.test",
        AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
      },
    );
  const disabled = await join(user!.account, "false");
  expect(disabled.status, await disabled.text()).toBe(503);
  expect((await join(user!.account, "true")).status).toBe(409);
  await stub().leaveAccount(user!.account.id);
  const response = await join(user!.account, "true");
  expect(response.status).toBe(200);
  expect(matchmakingStateSchema.parse(await response.json()).status).toBe("waiting");
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

test("参照だけでは期限処理や組合せを実行せず、30秒のAlarmで成立する", async () => {
  let now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const [u] = await fixture(1);
  const joined = now;
  now += 20000;
  await stub().control(
    u!.account.id,
    { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
    "heartbeat",
  );
  now = joined + 30000;
  for (let i = 0; i < 3; i++)
    expect((await stub().status(u!.account.id, u!.controllerId)).status).toBe("waiting");
  await runInDurableObject(stub(), (instance) => instance.alarm());
  const matched = await stub().status(u!.account.id, u!.controllerId);
  expect(matched.status).toBe("matched");
  rooms.add(matched.assignment!.roomId);
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

test("大会待機との相互排他をD1で守り、取消後だけ待機先を切り替えられる", async () => {
  const [u] = await fixture(1);
  const key = crypto.randomUUID(),
    now = Date.now();
  await env.APP_DB.prepare(
    "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms) VALUES(?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'排他確認',?,?,1,?,?)",
  )
    .bind(key, now - 1, now + 60000, now, now)
    .run();
  const reserve = () =>
    env.APP_DB.prepare(
      "INSERT INTO tournament_wait_reservations(account_id,tournament_key,operation_id,lease_until_ms) VALUES(?,?,?,?)",
    )
      .bind(u!.account.id, key, crypto.randomUUID(), now + 30000)
      .run();
  try {
    await expect(reserve()).rejects.toThrow();
    await stub().control(
      u!.account.id,
      { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
      "cancel",
    );
    await reserve();
    expect((await stub().join(u!.account.id, crypto.randomUUID(), u!.controllerId)).ok).toBe(false);
  } finally {
    await env.APP_DB.prepare("DELETE FROM tournament_wait_reservations WHERE account_id=?")
      .bind(u!.account.id)
      .run();
    await env.APP_DB.prepare("DELETE FROM tournaments WHERE key=?").bind(key).run();
  }
});

test("ログアウトで待機を解除し、退会・ゲスト連携は待機を越えて成立しない", async () => {
  const [u] = await fixture(1);
  await expect(requireGuestIdle(env, u!.account.id)).rejects.toThrow();
  const signedOut = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: u!.account.headers,
      body: "{}",
    }),
  );
  expect(signedOut.status).toBe(200);
  expect((await stub().status(u!.account.id, u!.controllerId)).status).toBe("idle");
  const v = (await fixture(1))[0]!;
  expect(await requestDeletion(env, v.account.id, crypto.randomUUID())).toBe(true);
  await runInDurableObject(stub(), (instance) => instance.alarm());
  expect((await stub().status(v.account.id, v.controllerId)).status).toBe("idle");
  expect((await stub().join(v.account.id, crypto.randomUUID(), v.controllerId)).ok).toBe(false);
  await stub().purgeAccount(v.account.id);
});
for (const humans of [1, 2, 3, 4])
  test(`人間${humans}人で成立し3分切れ負け・不足席のヨミを固定する`, async () => {
    const users = await fixture(humans);
    if (humans < 4) {
      expect((await stub().status(users[0]!.account.id)).status).toBe("waiting");
      await fill();
    }
    const states = await Promise.all(users.map((u) => stub().status(u.account.id, u.controllerId)));
    for (const state of states) {
      expect(state.status).toBe("matched");
      expect(state.assignment).toBeDefined();
      rooms.add(state.assignment!.roomId);
    }
    expect(new Set(states.map((s) => s.assignment!.matchId)).size).toBe(1);
    const a = states[0]!.assignment!;
    const room = roomSchema.parse(await env.GAME_ROOM.getByName(a.roomId).getRoom());
    expect(room.settings.timeControl).toEqual({ mainTimeMs: 180000, byoyomiMs: 0 });
    expect(room.players.filter((p) => p.kind === "human")).toHaveLength(humans);
    const cpus = room.players.filter((p) => p.kind === "cpu");
    expect(cpus).toHaveLength(4 - humans);
    expect(cpus.map((p) => p.name)).toEqual(
      Array.from({ length: 4 - humans }, (_, i) => `ヨミ${i + 1}`),
    );
    for (const p of cpus) {
      expect(p.cpuProfile?.id).toBe("lv3-v1");
      expect(p.cpuProfile?.level).toBe(3);
      expect(p.cpuProfile?.style).toBe("多人数の先読み");
    }
    const outsiders = await exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/rooms/${a.roomId}/join`, {
        method: "POST",
        headers: users[0]!.account.headers,
        body: JSON.stringify({ name: "横入り" }),
      }),
    );
    expect(outsiders.status).not.toBe(200);
  });
test("待機・再読み込み・旧操作元の取消が重複割当や待機延長を起こさない", async () => {
  const [u] = await fixture(1);
  const before = await stub().status(u!.account.id, u!.controllerId);
  expect((await stub().join(u!.account.id, u!.operationId, u!.controllerId)).ok).toBe(true);
  await evictDurableObject(stub());
  const after = await stub().status(u!.account.id, u!.controllerId);
  expect(after.joinedAtMs).toBe(before.joinedAtMs);
  expect(after.operationId).toBe(before.operationId);
  const controllerId = crypto.randomUUID();
  const transfer = await stub().takeover(u!.account.id, u!.operationId, controllerId, 1);
  expect(transfer.ok).toBe(true);
  expect(
    (
      await stub().control(
        u!.account.id,
        { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
        "cancel",
      )
    ).ok,
  ).toBe(false);
  expect((await stub().status(u!.account.id, controllerId)).status).toBe("waiting");
  expect((await stub().takeover(u!.account.id, u!.operationId, crypto.randomUUID(), 1)).ok).toBe(
    false,
  );
  expect(
    (
      await stub().control(
        u!.account.id,
        { operationId: u!.operationId, controllerId, version: 2 },
        "cancel",
      )
    ).ok,
  ).toBe(true);
  expect((await stub().join(u!.account.id, u!.operationId, controllerId)).ok).toBe(false);
});
test("全員の接続後だけカウントダウンし、再起動しても1回だけ開始する", async () => {
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
test("待機中の通常ルーム参加を拒否し、取消後は参加できる", async () => {
  const [u] = await fixture(1);
  const create = () =>
    exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/rooms`, {
        method: "POST",
        headers: u!.account.headers,
        body: JSON.stringify({
          game: "four-reversi",
          mode: "singles",
          quickPlay: false,
          name: "参加者",
        }),
      }),
    );
  expect((await create()).status).toBe(409);
  expect(
    (
      await stub().control(
        u!.account.id,
        { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 },
        "cancel",
      )
    ).ok,
  ).toBe(true);
  const response = await create();
  expect(response.status).toBe(201);
  const body = (await response.json()) as { room: { id: string } };
  rooms.add(body.room.id);
  expect((await stub().join(u!.account.id, crypto.randomUUID(), u!.controllerId)).ok).toBe(false);
});
test("Serviceの準備前は新しいマッチングを受け付けない", async () => {
  const account = await accountFixture();
  accounts.push(account.id);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/four-reversi/join`, {
      method: "POST",
      headers: account.headers,
      body: JSON.stringify({ controllerId: crypto.randomUUID(), operationId: crypto.randomUUID() }),
    }),
  );
  expect(response.status).toBe(503);
  const state = await exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api/matchmaking/four-reversi`, { headers: account.headers }),
  );
  expect(matchmakingStateSchema.parse(await state.json()).enabled).toBe(false);
});

test("席の確保が一時的に失敗しても、待機を消さず元の優先度で再試行する", async () => {
  const users = await fixture(3);
  const fourth = await accountFixture();
  accounts.push(fourth.id);
  const operationId = crypto.randomUUID(),
    controllerId = crypto.randomUUID();
  const before = await stub().status(users[0]!.account.id, users[0]!.controllerId);
  await env.APP_DB.exec(
    "CREATE TRIGGER fail_matchmaking_transfer BEFORE INSERT ON account_room_seats BEGIN SELECT RAISE(ABORT,'test matchmaking transfer'); END",
  );
  try {
    const result = await stub().join(fourth.id, operationId, controllerId);
    expect(result.ok).toBe(true);
    const pending = await stub().status(users[0]!.account.id, users[0]!.controllerId);
    expect(pending.status).toBe("waiting");
    expect(pending.joinedAtMs).toBe(before.joinedAtMs);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER IF EXISTS fail_matchmaking_transfer");
  }
  await runInDurableObject(stub(), async (_, state) => {
    const value = state.storage.kv.get<{ waiting: { retryAtMs?: number }[] }>("state")!;
    for (const waiting of value.waiting) waiting.retryAtMs = Date.now() - 1;
    state.storage.kv.put("state", value);
  });
  await runInDurableObject(stub(), (instance) => instance.alarm());
  const recovered = await stub().status(fourth.id, controllerId);
  expect(recovered.status).toBe("matched");
  rooms.add(recovered.assignment!.roomId);
  expect(
    (await stub().status(users[0]!.account.id, users[0]!.controllerId)).assignment?.matchId,
  ).toBe(recovered.assignment!.matchId);
});

test("待機が失効した後の遅延更新・再参加は古い操作を復活させない", async () => {
  const [user] = await fixture(1);
  await runInDurableObject(stub(), async (_, state) => {
    const value = state.storage.kv.get<{ waiting: { expiresAtMs: number }[] }>("state")!;
    value.waiting[0]!.expiresAtMs = Date.now();
    state.storage.kv.put("state", value);
  });
  expect((await stub().status(user!.account.id, user!.controllerId)).status).toBe("idle");
  expect(
    (
      await stub().control(
        user!.account.id,
        { operationId: user!.operationId, controllerId: user!.controllerId, version: 1 },
        "heartbeat",
      )
    ).ok,
  ).toBe(false);
  expect((await stub().join(user!.account.id, user!.operationId, user!.controllerId)).ok).toBe(
    false,
  );
  expect((await stub().join(user!.account.id, crypto.randomUUID(), user!.controllerId)).ok).toBe(
    true,
  );
});

test("四人レート戦は10秒で範囲を広げ、20秒で実力差を解除する", () => {
  const waits = [25, 31, 30, 32, 26].map((rating) => ({ rating, sigma: 2, ratedGames: 10 }));
  expect(selectFourReversi(waits, 9_999)).toBeUndefined();
  expect(selectFourReversi(waits, 10_000)?.selected.map((w) => w.rating)).toEqual([25, 31, 30, 26]);
  const far = [25, 36, 30, 40].map((rating) => ({ rating, sigma: 2, ratedGames: 10 }));
  expect(selectFourReversi(far, 19_999)).toBeUndefined();
  expect(selectFourReversi(far, 20_000)?.selected).toEqual(far);
  expect(selectFourReversi([...far, { rating: 21, sigma: 7, ratedGames: 2 }], 0)?.selected).toEqual(
    far,
  );
  expect(selectFourReversi(waits.slice(0, 3), 19_999)).toBeUndefined();
  expect(selectFourReversi(waits.slice(0, 3), 20_000)?.rating.cpu?.profileId).toBe("lv5-v1");
  expect(selectFourReversi([{ rating: 11, ratedGames: 5 }], 20_000)?.rating.cpu?.profileId).toBe(
    "lv1-v1",
  );
  expect(selectFourReversi([{ rating: 11, ratedGames: 4 }], 20_000)?.rating.cpu?.profileId).toBe(
    "lv3-v1",
  );
});

test("四人レート戦は20秒で不足席を補充し、成立後の取消で割当を解除しない", async () => {
  let now = Date.now() + 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const queue = fourRatedQueue();
  const [first, second] = await fixture(2, queue);
  now += 19_999;
  await runInDurableObject(queue, (instance) => instance.alarm());
  expect((await queue.status(first!.account.id, first!.controllerId)).status).toBe("waiting");
  now += 1;
  const cancelled = await queue.control(
    first!.account.id,
    {
      operationId: first!.operationId,
      controllerId: first!.controllerId,
      version: 1,
    },
    "cancel",
  );
  expect(cancelled).toMatchObject({
    ok: true,
    state: { status: "matched", assignment: { opponent: "cpu" } },
  });
  if (!cancelled.ok || !cancelled.state.assignment) throw Error("Expected assignment");
  const a = cancelled.state.assignment;
  rooms.add(a.roomId);
  expect((await queue.status(second!.account.id, second!.controllerId)).assignment?.matchId).toBe(
    a.matchId,
  );
  const room = roomSchema.parse(await env.GAME_ROOM.getByName(a.roomId).getRoom());
  expect(room).toMatchObject({
    matchmaking: { rated: true },
    settings: { mode: "singles", timeControl: { mainTimeMs: 180_000, byoyomiMs: 0 } },
  });
  const cpus = room.players.filter((p) => p.kind === "cpu");
  expect(cpus).toHaveLength(2);
  for (const cpu of cpus) expect(cpu).toMatchObject({ cpuProfile: { id: "lv3-v1" } });
});

test.each([
  { status: "abandoned", saved: false, canJoin: true },
  { status: "abandoned", saved: true, canJoin: false },
  { status: "playing", saved: false, canJoin: false },
  { status: "completed", saved: false, canJoin: false },
] as const)(
  "四人リバーシの再参加では中断が確定した未保存局の予約だけを解放する ($status, saved=$saved)",
  async ({ status, saved, canJoin }) => {
    const account = await accountFixture();
    accounts.push(account.id);
    const matchId = crypto.randomUUID();
    const now = Date.now();
    const db = env.APP_DB;
    await db.batch([
      db
        .prepare("INSERT INTO four_reversi_rating_pending (account_id,match_id) VALUES (?,?)")
        .bind(account.id, matchId),
      db
        .prepare(`INSERT INTO analytics_matches
        (id, game, mode, started_at_ms, ended_at_ms, status, cpu_count)
        VALUES (?, 'four-reversi', 'singles', ?, ?, ?, 3)`)
        .bind(matchId, now - 3000, status === "playing" ? null : now, status),
      ...(saved
        ? [
            db
              .prepare(`INSERT INTO matches
        (id, game, mode, started_at_ms, ended_at_ms, record_json)
        VALUES (?, 'four-reversi', 'singles', ?, ?, '{}')`)
              .bind(matchId, now - 3000, now),
          ]
        : []),
    ]);
    try {
      const result = await fourRatedQueue().join(
        account.id,
        crypto.randomUUID(),
        crypto.randomUUID(),
      );
      if (canJoin) expect(result).toMatchObject({ ok: true, state: { status: "waiting" } });
      else expect(result).toMatchObject({ ok: false, message: expect.stringContaining("保存中") });
      const pending = await db
        .prepare("SELECT 1 FROM four_reversi_rating_pending WHERE account_id=?")
        .bind(account.id)
        .first();
      expect(pending !== null).toBe(!canJoin);
    } finally {
      await db.batch([
        db.prepare("DELETE FROM analytics_matches WHERE id=?").bind(matchId),
        db.prepare("DELETE FROM matches WHERE id=?").bind(matchId),
      ]);
    }
  },
);

test.each([true, false])(
  "成立済みの四人対局が終了して保存され、レート戦だけ認定が進む rated=%s",
  async (rated) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = rated ? fourRatedQueue() : stub();
    const users = await fixture(4, queue);
    const states = await Promise.all(users.map((u) => queue.status(u.account.id, u.controllerId)));
    const a = states[0]!.assignment!;
    rooms.add(a.roomId);
    const roomStub = env.GAME_ROOM.getByName(a.roomId);
    const result = (account = users[0]!.account) =>
      exports.default.fetch(
        new AcceptedGameRequest(
          `${origin}/api/matchmaking/four-reversi/results/${a.matchId}?includeOpponent=1`,
          { headers: account.headers },
        ),
      );
    if (rated) expect(await (await result()).json()).toEqual({ status: "pending" });
    else {
      const status = await exports.default.fetch(
        new AcceptedGameRequest(
          `${origin}/api/matchmaking/four-reversi?controllerId=${users[0]!.controllerId}`,
          { headers: users[0]!.account.headers },
        ),
      );
      expect(await status.json()).toMatchObject({
        enabled: false,
        status: "matched",
        assignment: a,
      });
      expect((await result()).status).toBe(404);
    }
    for (const state of states) await connect(a.roomId, state.assignment!.membership.token);
    expect(await roomStub.getRoom()).toMatchObject({
      status: "waiting",
      matchmaking: { startsAtMs: now + 5000 },
    });
    now += 5000;
    expect(await roomStub.getRoom()).toMatchObject({ status: "playing" });
    const matchStart = await runInDurableObject(roomStub, (_, state) =>
      state.storage.kv.get("match-start"),
    );
    expect(!!(matchStart as { fourReversiRating?: unknown })?.fourReversiRating).toBe(rated);
    for (const state of states.slice(1)) {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(state.assignment!.membership.token),
      );
      expect(
        await roomStub.leaveRoom(
          Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join(""),
        ),
      ).toBe("left");
    }
    await vi.waitFor(async () => {
      expect(
        await env.APP_DB.prepare("SELECT 1 FROM matches WHERE id=?").bind(a.matchId).first(),
      ).not.toBeNull();
      if (rated)
        expect(await (await result()).json()).toMatchObject({ status: "placement", games: 1 });
    });
    if (rated) {
      const payload = fourReversiRatingResultSchema.parse(await (await result()).json());
      expect(payload).toEqual({
        status: "placement",
        games: 1,
        players: Object.fromEntries(
          states
            .slice(1)
            .map((state) => [state.assignment!.membership.playerId, { status: "placement" }]),
        ),
      });
      const outsider = await accountFixture();
      accounts.push(outsider.id);
      expect((await result(outsider)).status).toBe(404);
    } else expect((await result()).status).toBe(404);
  },
);

test.each(["human", "random", "engine", "fallback"] as const)(
  "通常リバーシのレート戦を開始・保存する（%s）",
  async (scenario) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = reversiQueue();
    const users = await fixture(scenario === "human" ? 2 : 1, queue);
    const user = users[0]!;
    if (scenario !== "human") {
      now += 14_999;
      await runInDurableObject(queue, (instance) => instance.alarm());
      expect((await queue.status(user.account.id, user.controllerId)).status).toBe("waiting");
      now++;
      await runInDurableObject(queue, (instance) => instance.alarm());
    }
    const assignment = (await queue.status(user.account.id, user.controllerId)).assignment!;
    expect(assignment.opponent).toBe(scenario === "human" ? "human" : "cpu");
    rooms.add(assignment.roomId);
    const room = env.GAME_ROOM.getByName(assignment.roomId);
    const socket = await connect(assignment.roomId, assignment.membership.token);
    if (users[1]) {
      const other = users[1];
      const second = (await queue.status(other.account.id, other.controllerId)).assignment!;
      expect(second.matchId).toBe(assignment.matchId);
      await connect(second.roomId, second.membership.token);
    }
    now += 5000;
    const started = reversiRoomSchema.parse(await room.getRoom());
    if (started.status !== "playing") throw Error("Expected playing");
    expect(started.players.find((player) => player.kind === "cpu")?.name).toBe(
      scenario === "human" ? undefined : "クルリ",
    );
    expect(started.settings.timeControl).toEqual({ mainTimeMs: 180000, byoyomiMs: 0 });

    if (scenario !== "human") {
      const human = started.players.find((p) => p.id === assignment.membership.playerId)!;
      if (human.color === started.game.turn) {
        socket.send(
          JSON.stringify({
            type: "room.game.action",
            action: { type: "placeStone", position: getLegalMoves(started.game)[0] },
          }),
        );
      }
      const cpuPly = human.color === "black" ? 1 : 0;
      await vi.waitFor(async () =>
        expect(reversiRoomSchema.parse(await room.getRoom()).game?.moveNumber).toBe(cpuPly),
      );
      const before = reversiRoomSchema.parse(await room.getRoom());
      if (before.status !== "playing") throw Error("Expected playing");
      const aiMove = getLegalMoves(before.game).at(-1)!;
      const fetchAi = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        expect(new URL(String(url)).pathname).toBe("/v1/reversi/move");
        const input = JSON.parse(String(init?.body));
        expect(input.level).toBe(1);
        return scenario === "fallback"
          ? Response.json({ error: "unavailable" }, { status: 503 })
          : Response.json({
              request_id: input.request_id,
              position_revision: input.position_revision,
              engine_version: "egaroucid-console-7.8.2-0c1b84ef",
              level: input.level,
              position: aiMove,
            });
      });
      vi.spyOn(Math, "random").mockReturnValue(scenario === "random" ? 0.75 : 0.1);
      now = before.clock.turnStartedAt + 2000;
      await runInDurableObject(room, async (instance) => {
        const original = Reflect.get(instance, "env");
        Reflect.set(instance, "env", {
          ...original,
          AI_REVERSI_ENABLED: "true",
          AI_SERVICE_URL: "https://ai.example.test",
          AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
        });
        try {
          await instance.alarm();
          if (scenario !== "random") await instance.alarm();
        } finally {
          Reflect.set(instance, "env", original);
        }
      });
      expect(fetchAi).toHaveBeenCalledTimes(scenario === "random" ? 0 : 1);
      fetchAi.mockRestore();
      const moved = reversiRoomSchema.parse(await room.getRoom()).game;
      expect(moved?.moveNumber).toBe(cpuPly + 1);
      expect(getLegalMoves(before.game)).toContainEqual(moved?.lastMove);
      if (scenario === "engine") expect(moved?.lastMove).toEqual(aiMove);
    }

    const tokenHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(assignment.membership.token),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(await room.leaveRoom(tokenHash)).toBe("left");
    await vi.waitFor(async () => {
      now++;
      await room.getRoom();
      const saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
        .bind(assignment.matchId)
        .first<{ record_json: string }>();
      expect(saved).toBeTruthy();
      expect(JSON.parse(saved!.record_json).rating).toMatchObject(
        scenario === "human" ? { kind: "human" } : { kind: "cpu", referenceRating: 1490 },
      );
      const response = await exports.default.fetch(
        new AcceptedGameRequest(
          `${origin}/api/matchmaking/reversi/results/${assignment.matchId}?includeOpponent=1`,
          { headers: user.account.headers },
        ),
      );
      expect(await response.json()).toEqual(
        scenario === "fallback"
          ? { status: "excluded", reason: "ai_fallback" }
          : {
              status: "placement",
              games: 1,
              opponent:
                scenario === "human" ? { status: "placement" } : { status: "cpu", rating: 1490 },
            },
      );
      const changes = await env.APP_DB.prepare(
        "SELECT account_id,rating_after,human_games FROM reversi_rating_changes WHERE match_id=?",
      )
        .bind(assignment.matchId)
        .all<{ account_id: string; rating_after: number; human_games: number }>();
      expect(changes.results).toHaveLength(scenario === "fallback" ? 0 : users.length);
      if (scenario !== "fallback") {
        const self = changes.results.find((row) => row.account_id === user.account.id)!;
        expect(self.human_games).toBe(scenario === "human" ? 1 : 0);
        expect(self.rating_after).toBeCloseTo(
          scenario === "human" ? 1468 : 1500 - 48 / (1 + 10 ** (-10 / 400)),
        );
      }
      expect(
        await env.APP_DB.prepare(
          "SELECT COUNT(*) AS count FROM reversi_rating_pending WHERE match_id=?",
        )
          .bind(assignment.matchId)
          .first("count"),
      ).toBe(0);
    });
    const saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
      .bind(assignment.matchId)
      .first<string>("record_json");
    const record = reversiMatchData.read(saved!);
    expect(
      record.participants.filter((player) => player.kind === "cpu").map((player) => player.name),
    ).toEqual(scenario === "human" ? [] : ["クルリ"]);
    for (const player of record.participants) {
      const query = new URLSearchParams({
        source: "match",
        matchId: record.id,
        playerId: player.id,
        game: "reversi",
        includeRating: "1",
      });
      const response = await exports.default.fetch(
        new AcceptedGameRequest(`${origin}/api/player-profile?${query}`),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        rating:
          player.kind === "cpu"
            ? { timing: "reference", status: "rated", rating: 1490 }
            : { timing: "before", status: "placement" },
      });
    }
    const replay = await exports.default.fetch(
      new AcceptedGameRequest(`${origin}/api/matches/${assignment.matchId}`),
    );
    expect(replay.status).toBe(200);
    const { match } = getPublicMatchContract.response.parse(await replay.json());
    expect(
      match.participants.filter((player) => player.kind === "cpu").map((player) => player.name),
    ).toEqual(scenario === "human" ? [] : ["クルリ"]);
    await writeMatch(env.APP_DB, record);
    expect(
      await env.APP_DB.prepare("SELECT COUNT(*) FROM reversi_rating_changes WHERE match_id=?")
        .bind(assignment.matchId)
        .first("COUNT(*)"),
    ).toBe(scenario === "fallback" ? 0 : users.length);
  },
);

test.each(["four-shogi", "four-reversi", "shogi", "reversi"] as const)(
  "%sのCPU補充局は公開番号を保持し、再取得・DO再起動で再採番しない",
  async (game) => {
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    const [user] = await fixture(1, queue);
    await runInDurableObject(queue, (_, ctx) => {
      const state = ctx.storage.kv.get<{ waiting: { joinedAtMs: number }[] }>("state")!;
      state.waiting[0]!.joinedAtMs = Date.now() - 60000;
      ctx.storage.kv.put("state", state);
    });
    await runInDurableObject(queue, (instance) => instance.alarm());
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
