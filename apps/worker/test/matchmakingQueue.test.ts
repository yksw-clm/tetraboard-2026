import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { matchmakingStateSchema, roomSchema } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { selectFourReversi } from "../src/adapters/matchmaking/fourReversiSelection";
import {
  useMatchmakingFixtures,
  stub,
  fourRatedQueue,
  accounts,
  rooms,
  fixture,
  fill,
} from "./matchmakingFixtures";

useMatchmakingFixtures();

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
    settings: { mode: "singles", timeControl: { mainTimeMs: 0, byoyomiMs: 30_000 } },
  });
  const cpus = room.players.filter((p) => p.kind === "cpu");
  expect(cpus).toHaveLength(2);
  for (const cpu of cpus) expect(cpu).toMatchObject({ cpuProfile: { id: "lv3-v1" } });
});
