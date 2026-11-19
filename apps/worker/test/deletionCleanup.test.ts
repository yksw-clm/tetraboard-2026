import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { challengeCookie, flowCookie } from "../src/adapters/privacy/deletionCookies";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { disposeDurableObjects } from "./durableObjectCleanup";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import { trackWorkerExecutions } from "./workerExecutionCleanup";

async function confirmDeletion({ wait = true, native = false } = {}) {
  const user = await accountFixture();
  const session = await env.APP_DB.prepare("SELECT id FROM session WHERE token=?")
    .bind(user.token)
    .first<{ id: string }>();
  const challenge = crypto.randomUUID();
  const flow = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT INTO deletion_challenges(id,account_id,provider,created_at_ms,expires_at_ms,verified_at_ms,verified_session_id) VALUES (?,?,?,?,?,?,?)",
    ).bind(challenge, user.id, "google", Date.now(), Date.now() + 600000, Date.now(), session!.id),
    env.APP_DB.prepare("INSERT INTO deletion_flows VALUES (?,?,?)").bind(
      flow,
      user.id,
      Date.now() + 86400000,
    ),
  ]);
  const context = createExecutionContext();
  const request = new Request(`${origin}/api/account/deletion/confirm`, {
    method: "POST",
    headers: {
      ...user.headers,
      Cookie: `${user.cookie}; ${challengeCookie}=${challenge}; ${flowCookie}=${flow}`,
    },
    body: JSON.stringify({ confirm: true }),
  });
  const response = native
    ? await exports.default.fetch(request)
    : await worker.fetch(request, env, context);
  expect(response.status).toBe(202);
  if (wait) await waitOnExecutionContext(context);
  return user.id;
}

// テスト間の後片づけ自体を検証するため、前半の残件を後半で観測します。
describe.sequential("共有D1の退会と部屋索引の後片づけ", () => {
  let previousAccountId: string;
  const previousRooms: string[] = [];

  test("未完了の退会ジョブと部屋索引を残して終了する", async () => {
    const fixtures = new RoomBoundaryFixtures();
    for (let i = 0; i < 3; i++) {
      const entry = await fixtures.create({ game: "shogi", name: "前のテスト", quickPlay: false });
      previousRooms.push(entry.room.id);
    }
    const user = await accountFixture();
    previousAccountId = user.id;
    expect(await requestDeletion(env, user.id, crypto.randomUUID())).toBe(true);
    expect(
      await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
        .bind(user.id)
        .first(),
    ).toEqual({ completed_at_ms: null });
    const rooms = await env.APP_DB.prepare("SELECT room_id FROM deletion_rooms WHERE account_id=?")
      .bind(user.id)
      .all<{ room_id: string }>();
    expect(rooms.results.map((room) => room.room_id)).toEqual(
      expect.arrayContaining(previousRooms),
    );
  });

  test("次の退会確定とDOの後片づけは前のテストの部屋を巡回しない", async () => {
    const fixtures = new RoomBoundaryFixtures();
    const current = await fixtures.create({
      game: "shogi",
      name: "今回のテスト",
      quickPlay: false,
    });
    const get = vi.spyOn(env.GAME_ROOM, "getByName");
    try {
      const accountId = await confirmDeletion();
      await disposeDurableObjects();
      const visited = get.mock.calls.map(([name]) => name);
      expect(visited.filter((name) => previousRooms.includes(name))).toEqual([]);
      expect(visited).toEqual([current.room.id]);
      expect(
        (
          await env.APP_DB.prepare("SELECT room_id FROM deletion_rooms WHERE account_id=?")
            .bind(previousAccountId)
            .all()
        ).results,
      ).toEqual([]);
      expect(
        await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
          .bind(accountId)
          .first(),
      ).toEqual({ completed_at_ms: expect.any(Number) });
      expect(
        await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
          .bind(previousAccountId)
          .first(),
      ).toEqual({ completed_at_ms: expect.any(Number) });
      expect(
        await env.APP_DB.prepare("SELECT id FROM user WHERE id=?").bind(previousAccountId).first(),
      ).toEqual({ id: previousAccountId });
    } finally {
      get.mockRestore();
    }
  });
});

test.each([false, true])("waitUntilの回収は退会処理の完了を待つ（native=%s）", async (native) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prepare = env.APP_DB.prepare.bind(env.APP_DB);
  const spy = vi.spyOn(env.APP_DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.includes("FROM deleted_accounts WHERE completed_at_ms IS NULL")) return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === "all")
          return async () => {
            entered.resolve();
            await release.promise;
            return target.all();
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  const finish = trackWorkerExecutions();
  let stopped: Promise<void> | undefined;
  try {
    const accountId = await confirmDeletion({ wait: false, native });
    await entered.promise;
    let finished = false;
    stopped = finish().then(() => {
      finished = true;
    });
    expect(
      await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
        .bind(accountId)
        .first(),
    ).toEqual({ completed_at_ms: null });
    expect(finished).toBe(false);
    release.resolve();
    await stopped;
    expect(
      await env.APP_DB.prepare("SELECT id FROM user WHERE id=?").bind(accountId).first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
        .bind(accountId)
        .first(),
    ).toEqual({ completed_at_ms: expect.any(Number) });
  } finally {
    release.resolve();
    await (stopped ?? finish());
    spy.mockRestore();
  }
});
