import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { matchmakingQueues } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { matchmakingRoutes } from "../src/routes/matchmaking";
import { CpuCapacity } from "../src/durableObjects/cpuCapacity";
import {
  useMatchmakingFixtures,
  stub,
  shogiQueue,
  accounts,
  rooms,
  fixture,
  ratedAccount,
} from "./matchmakingFixtures";

useMatchmakingFixtures();

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
