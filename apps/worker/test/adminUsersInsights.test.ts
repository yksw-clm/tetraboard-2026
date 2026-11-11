import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { backfillAccountTotals } from "../src/analytics/foundation";
import { AcceptedGameRequest } from "./acceptedGameRequest";
const context = { waitUntil() {} } as unknown as ExecutionContext;
test("管理ユーザーは最終日時・完了局数・ゲーム別現在レートを一括取得し、条件付きカーソルと詳細を扱う", async () => {
  const owner = await accountFixture();
  const name = `insights-${crypto.randomUUID()}`;
  const first = await accountFixture(),
    second = await accountFixture();
  await env.APP_DB.batch(
    [first, second].map((u) =>
      env.APP_DB.prepare("UPDATE user SET name=? WHERE id=?").bind(name, u.id),
    ),
  );
  const at = Date.parse("2026-11-11T01:00:00Z"),
    match = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO account_usage VALUES(?,?,?)").bind(first.id, at, "2026-11-11"),
    env.APP_DB.prepare("INSERT INTO matches VALUES(?,'shogi','standard',?,?,'{}')").bind(
      match,
      at,
      at + 1000,
    ),
    env.APP_DB.prepare(
      "INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game) VALUES(?,?,'standard',?,'shogi')",
    ).bind(first.id, match, at),
    env.APP_DB.prepare("INSERT INTO shogi_rating_changes VALUES(?,?,1500,1550,5,1)").bind(
      match,
      first.id,
    ),
  ]);
  await backfillAccountTotals(env.APP_DB);
  const sql: string[] = [];
  const db = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (s: string) => {
          sql.push(s);
          return target.prepare(s);
        };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const bindings = { ...env, APP_DB: db, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  const get = (path: string) =>
    worker.fetch(
      new AcceptedGameRequest(origin + path, { headers: { Cookie: owner.cookie } }),
      bindings,
      context,
    );
  const query = `/api/admin/users?search=${name}&from=2026-11-11&to=2026-11-11&game=shogi&sort=completed&direction=desc`;
  const response = await get(query);
  expect(response.status).toBe(200);
  const data = (await response.json()) as { users: Record<string, any>[] };
  expect(data.users[0]).toMatchObject({
    id: first.id,
    lastLoginAtMs: at,
    lastUsedDay: "2026-11-11",
    completed: 1,
    periodCompleted: 1,
  });
  expect(data.users[0]!.ratings.shogi).toMatchObject({
    status: "rated",
    rating: 1550,
    ratedGames: 5,
  });
  const detail = await get(`/api/admin/users/${first.id}?from=2026-11-11&to=2026-11-11&game=shogi`);
  expect(detail.status).toBe(200);
  expect(((await detail.json()) as any).user.id).toBe(first.id);
  expect(
    sql
      .filter((s) => !/^update "session"/i.test(s))
      .filter((s) => /sqlite_master|pragma_table_info|\b(INSERT|DELETE|UPDATE)\b/i.test(s)),
  ).toEqual([]);
});

test("50件と次ページは日本語検索・同値順でも重複せず、問い合わせ数が人数で増えない", async () => {
  const { readAdminUsers } = await import("../src/admin/users");
  const { adminUsersQuerySchema } = await import("@tetraboard/protocol");
  const name = `分析${crypto.randomUUID()}`;
  const users = [];
  for (let i = 0; i < 51; i++) users.push(await accountFixture());
  await env.APP_DB.batch(
    users.map((u) =>
      env.APP_DB.prepare("UPDATE user SET name=?,createdAt=1 WHERE id=?").bind(name, u.id),
    ),
  );
  let count = 0;
  const db = new Proxy(env.APP_DB, {
    get(t, k) {
      if (k === "prepare")
        return (s: string) => {
          count++;
          return t.prepare(s);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const q = adminUsersQuerySchema.parse({ search: name });
  const first = await readAdminUsers(db, q);
  const firstCount = count;
  expect(first.users).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  count = 0;
  const second = await readAdminUsers(db, { ...q, cursor: first.nextCursor! });
  expect(second.users).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(count).toBe(firstCount);
  expect(new Set([...first.users, ...second.users].map((u) => u.id)).size).toBe(51);
  await expect(
    readAdminUsers(db, { ...q, sort: "lastUsed", cursor: first.nextCursor! }),
  ).rejects.toThrow();
  expect(first.users.every((u) => u.completed === null && u.lastLoginAtMs === null)).toBe(true);
});

test("ゲストはレートとログインの対象外、退会受付で期間集計と詳細を除外する", async () => {
  const { readAdminUsers } = await import("../src/admin/users");
  const { adminUsersQuerySchema } = await import("@tetraboard/protocol");
  const guest = await accountFixture();
  await env.APP_DB.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest.id).run();
  await backfillAccountTotals(env.APP_DB);
  const q = adminUsersQuerySchema.parse({ kind: "guest" });
  const before = await readAdminUsers(env.APP_DB, q, guest.id);
  expect(before.users[0]!.ratings!.shogi!.status).toBe("ineligible");
  expect(before.users[0]!.lastLoginAtMs).toBeNull();
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)",
  )
    .bind(guest.id, Date.now(), crypto.randomUUID())
    .run();
  expect((await readAdminUsers(env.APP_DB, q, guest.id)).users).toEqual([]);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM account_insights_ready WHERE account_id=?")
      .bind(guest.id)
      .first(),
  ).toBeNull();
});

test("新しい管理取得は未認証・権限不足・不正条件・D1障害を区別してno-storeで閉じる", async () => {
  const owner = await accountFixture(),
    other = await accountFixture();
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  const get = (path: string, cookie?: string, db = env.APP_DB) =>
    worker.fetch(
      new AcceptedGameRequest(origin + path, { headers: cookie ? { Cookie: cookie } : {} }),
      { ...bindings, APP_DB: db },
      context,
    );
  for (const path of [
    `/api/admin/users/${other.id}`,
    "/api/admin/analytics/acquisition?from=2026-11-11&to=2026-11-11",
  ]) {
    expect((await get(path)).status).toBe(401);
    expect((await get(path, other.cookie)).status).toBe(403);
  }
  for (const query of [
    "from=2026-11-11",
    "from=2026-11-12&to=2026-11-11",
    "sort=arbitrary",
    "cursor=invalid",
  ]) {
    const response = await get(`/api/admin/users?${query}`, owner.cookie);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const db = new Proxy(env.APP_DB, {
    get(t, k) {
      if (k === "prepare")
        return (s: string) => {
          if (s.includes("WITH totals AS")) throw new Error("test read failure");
          return t.prepare(s);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const failed = await get("/api/admin/users", owner.cookie, db);
  expect(failed.status).toBe(503);
  expect(failed.headers.get("Cache-Control")).toBe("no-store");
  expect(await failed.text()).not.toContain("test read failure");
});

test("期間局数は日本時間の完了日で数え、90日より前を0件にしない", async () => {
  const { readAdminUsers } = await import("../src/admin/users");
  const { adminUsersQuerySchema } = await import("@tetraboard/protocol");
  const user = await accountFixture(),
    boundary = Date.parse("2026-11-11T00:00:00+09:00");
  for (const end of [boundary - 1, boundary]) {
    const id = crypto.randomUUID();
    await env.APP_DB.batch([
      env.APP_DB.prepare("INSERT INTO matches VALUES(?,'gomoku','standard',?,?,'{}')").bind(
        id,
        end - 1000,
        end,
      ),
      env.APP_DB.prepare(
        "INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game) VALUES(?,?,'standard',?,'gomoku')",
      ).bind(user.id, id, end - 1000),
    ]);
  }
  await backfillAccountTotals(env.APP_DB);
  const q = adminUsersQuerySchema.parse({ game: "gomoku", from: "2026-11-11", to: "2026-11-11" });
  const today = (await readAdminUsers(env.APP_DB, q, user.id)).users[0]!;
  expect(today.completed).toBe(2);
  expect(today.periodCompleted).toBe(1);
  const old = await readAdminUsers(
    env.APP_DB,
    { ...q, from: "2020-01-01", to: "2020-01-02" },
    user.id,
  );
  expect(old.periodAvailable).toBe(false);
  expect(old.users[0]!.periodCompleted).toBeNull();
});
