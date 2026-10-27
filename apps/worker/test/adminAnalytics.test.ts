import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import {
  adminAnalyticsSchema,
  adminUsersSchema,
  createRoomContract,
  roomSchema,
} from "@tetraboard/protocol";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { readAnalytics } from "../src/admin/metrics";
import {
  writeAnalyticsMatch,
  analyticsActiveKey,
  analyticsPendingPrefix,
  type AnalyticsMatch,
  type AnalyticsJob,
} from "../src/analytics/store";
import type { AdminEnv } from "../src/admin/auth";
import { matchSetup, matchStart, matchLeave, matchClients } from "./matchFixtures";
afterEach(() => vi.restoreAllMocks());
const context = { waitUntil: () => {} } as unknown as ExecutionContext;
const fetchWith = (bindings: AdminEnv, path: string, init?: RequestInit) =>
  worker.fetch(new AcceptedGameRequest(origin + path, init), bindings, context);
const visitor = () => crypto.randomUUID();
const cookie = (id: string) => `tetraboard-2026.analytics=${id}`;
function record(at: number, overrides: Partial<AnalyticsMatch> = {}): AnalyticsMatch {
  return {
    id: crypto.randomUUID(),
    game: "four-reversi",
    mode: "singles",
    startedAtMs: at,
    endedAtMs: at + 60000,
    status: "completed",
    cpuCount: 3,
    participants: [
      { playerId: crypto.randomUUID(), accountId: null, visitorId: visitor(), isTest: false },
    ],
    ...overrides,
  };
}
const query = {
  from: "2001-01-01",
  to: "2001-01-31",
  bucket: "day" as const,
  game: "all" as const,
  includeInternal: "false" as const,
};

test("管理API・HTMLは本人限定で、通報用トークンを流用せず、障害と未認証を区別する", async () => {
  const owner = await accountFixture();
  const other = await accountFixture();
  const bindings = { ...env, ADMIN_ACCOUNT_ID: owner.id };
  for (const path of [
    "/api/admin/session",
    "/api/admin/analytics?from=2001-01-01&to=2001-01-31",
    "/api/admin/users",
  ]) {
    expect((await fetchWith(bindings, path)).status).toBe(401);
    expect((await fetchWith(bindings, path, { headers: { Cookie: other.cookie } })).status).toBe(
      403,
    );
    expect(
      (
        await fetchWith(bindings, path, {
          headers: { Authorization: "Bearer test-moderator-token" },
        })
      ).status,
    ).toBe(401);
    const allowed = await fetchWith(bindings, path, { headers: { Cookie: owner.cookie } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Cache-Control")).toBe("no-store");
  }
  const assets = {
    fetch: async (request: Request) => new Response(new URL(request.url).pathname),
  } as Fetcher;
  const deployed = { ...bindings, ASSETS: assets };
  for (const path of [
    "/%61dmin/index.html",
    "/admin%2Fassets/example.js",
    "//admin/index.html",
    "/unused%2F..%2Fadmin/index.html",
  ])
    expect((await fetchWith(deployed, path)).status).toBe(302);
  const denied = await fetchWith(deployed, "/admin/users");
  expect(denied.status).toBe(302);
  expect(denied.headers.get("Location")).toBe(`${origin}/login?destination=admin`);
  expect((await fetchWith(deployed, "/admin", { headers: { Cookie: other.cookie } })).status).toBe(
    403,
  );
  expect(
    await (await fetchWith(deployed, "/admin/users", { headers: { Cookie: owner.cookie } })).text(),
  ).toBe("/admin/index.html");
  expect(
    await (
      await fetchWith(deployed, "/admin/assets/example.js", { headers: { Cookie: owner.cookie } })
    ).text(),
  ).toBe("/admin/assets/example.js");
  expect(
    (await fetchWith({ ...env, ADMIN_ACCOUNT_ID: undefined }, "/api/admin/session")).status,
  ).toBe(503);
  const failedDb = {
    prepare() {
      throw new Error("unavailable");
    },
  } as unknown as D1Database;
  expect(
    (
      await fetchWith({ ...bindings, APP_DB: failedDb }, "/api/admin/session", {
        headers: { Cookie: owner.cookie },
      })
    ).status,
  ).toBe(503);
});

test("日本時間の境界・月別・両ゲーム・内部参加者除外と進行状態を集計する", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2001-01-31T12:00:00+09:00"));
  const ownerId = visitor();
  const guestId = visitor();
  const before = Date.parse("2001-01-01T23:59:30+09:00");
  const first = record(before, {
    participants: [
      { playerId: visitor(), accountId: ownerId, visitorId: visitor(), isTest: false },
      { playerId: visitor(), accountId: null, visitorId: guestId, isTest: false },
    ],
  });
  await writeAnalyticsMatch(env.APP_DB, first);
  await writeAnalyticsMatch(
    env.APP_DB,
    record(before + 60000, {
      game: "four-shogi",
      mode: "doubles",
      status: "abandoned",
      cpuCount: 0,
    }),
  );
  await writeAnalyticsMatch(
    env.APP_DB,
    record(before + 120000, { status: "playing", endedAtMs: null }),
  );
  await writeAnalyticsMatch(
    env.APP_DB,
    record(before, {
      participants: [
        { playerId: visitor(), accountId: ownerId, visitorId: visitor(), isTest: false },
      ],
    }),
  );
  await writeAnalyticsMatch(
    env.APP_DB,
    record(before, {
      participants: [
        { playerId: visitor(), accountId: visitor(), visitorId: visitor(), isTest: true },
      ],
    }),
  );
  const data = await readAnalytics({ ...env, ADMIN_ACCOUNT_ID: ownerId }, query);
  expect(data.summary).toMatchObject({
    started: 3,
    completed: 1,
    abandoned: 1,
    playing: 1,
    guestActive: 3,
    registeredActive: 0,
    cpuMatches: 2,
    humanMatches: 1,
    singles: 2,
    doubles: 1,
    completionRate: 1 / 3,
  });
  expect(data.buckets[0].metrics.started).toBe(1);
  expect(data.buckets[1].metrics.started).toBe(2);
  const monthly = await readAnalytics(
    { ...env, ADMIN_ACCOUNT_ID: ownerId },
    { ...query, bucket: "month", game: "four-shogi" },
  );
  expect(monthly.buckets).toHaveLength(1);
  expect(monthly.summary).toMatchObject({ started: 1, abandoned: 1 });
  const included = await readAnalytics(
    { ...env, ADMIN_ACCOUNT_ID: ownerId },
    { ...query, includeInternal: "true" },
  );
  expect(included.summary.started).toBe(5);
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "DELETE FROM analytics_participants WHERE match_id IN (SELECT id FROM analytics_matches WHERE started_at_ms >= ? AND started_at_ms < ?)",
    ).bind(Date.parse("2001-01-01"), Date.parse("2001-02-01")),
    env.APP_DB.prepare(
      "DELETE FROM analytics_matches WHERE started_at_ms >= ? AND started_at_ms < ?",
    ).bind(Date.parse("2001-01-01"), Date.parse("2001-02-01")),
  ]);
});

test("訪問との開始率・初回完了から7日以内の再対局・観測未完了・期間のユニーク数", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2001-01-31T12:00:00+09:00"));
  const at = Date.parse("2001-01-03T12:00:00+09:00");
  const guest = visitor();
  const account = visitor();
  const browser = visitor();
  for (const day of [0, 1])
    await env.APP_DB.prepare(
      "INSERT INTO analytics_pageviews (id, visitor_id, page, game, started_at_ms) VALUES (?, ?, 'lobby', 'four-reversi', ?)",
    )
      .bind(visitor(), browser, at + day * 86400000)
      .run();
  const actor = { playerId: visitor(), accountId: account, visitorId: browser, isTest: false };
  const initial = record(at, {
    participants: [
      actor,
      { playerId: visitor(), accountId: null, visitorId: guest, isTest: false },
    ],
  });
  await writeAnalyticsMatch(env.APP_DB, initial);
  await writeAnalyticsMatch(
    env.APP_DB,
    record(initial.endedAtMs! + 604800000, { participants: [{ ...actor, playerId: visitor() }] }),
  );
  await writeAnalyticsMatch(
    env.APP_DB,
    record(initial.endedAtMs! + 604800001, {
      participants: [{ playerId: visitor(), accountId: null, visitorId: guest, isTest: false }],
    }),
  );
  const data = await readAnalytics(env, query);
  expect(data.summary).toMatchObject({
    visitors: 1,
    pageViews: 2,
    conversionEligible: 1,
    converted: 1,
    startRate: 1,
    registeredActive: 1,
    guestActive: 1,
    registeredRetentionEligible: 1,
    registeredRetained: 1,
    guestRetentionEligible: 1,
    guestRetained: 0,
  });
  const current = record(Date.now() - 100000);
  await writeAnalyticsMatch(env.APP_DB, current);
  const today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
  const recent = await readAnalytics(env, { ...query, from: today, to: today });
  expect(recent.summary.guestRetentionEligible).toBe(0);
  const empty = await readAnalytics(env, { ...query, from: "1990-01-01", to: "1990-01-01" });
  expect(empty.summary).toMatchObject({
    started: 0,
    startRate: null,
    completionRate: null,
    guestRetentionRate: null,
  });
});

test("ブラウザ計測はOriginと形式を検証し、他ブラウザの更新・重複・時間水増しを拒否する", async () => {
  const id = visitor();
  const browser = visitor();
  const headers = { Origin: origin, Cookie: cookie(browser), "Content-Type": "application/json" };
  const input = { id, page: "lobby", game: "four-reversi" };
  expect(
    (
      await fetchWith(env, "/api/analytics/pageviews", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(403);
  for (let attempt = 0; attempt < 2; attempt++)
    expect(
      (
        await fetchWith(env, "/api/analytics/pageviews", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(204);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS count FROM analytics_pageviews WHERE id = ?")
      .bind(id)
      .first(),
  ).toEqual({ count: 1 });
  expect(
    (
      await fetchWith(env, "/api/analytics/pageviews", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...input, url: "private" }),
      })
    ).status,
  ).toBe(400);
  const at = Date.now();
  const day = new Date(at + 32400000).toISOString().slice(0, 10);
  await env.APP_DB.prepare("UPDATE analytics_pageviews SET started_at_ms = ? WHERE id = ?")
    .bind(at - 60000, id)
    .run();
  const update = (milliseconds: number, requestedHeaders = headers) =>
    fetchWith(env, "/api/analytics/dwell", {
      method: "POST",
      headers: requestedHeaders,
      body: JSON.stringify({ id, days: [{ day, milliseconds }] }),
    });
  expect((await update(30000)).status).toBe(204);
  expect((await update(20000)).status).toBe(204);
  expect(
    await env.APP_DB.prepare("SELECT milliseconds FROM analytics_dwell WHERE view_id = ?")
      .bind(id)
      .first(),
  ).toEqual({ milliseconds: 30000 });
  expect((await update(30000, { ...headers, Cookie: cookie(visitor()) })).status).toBe(404);
  expect((await update(86400000)).status).toBe(400);
});

test("ユーザー一覧は種別ごとに日時形式の混在・未完了・検索・同時刻のページングに対応する", async () => {
  const owner = await accountFixture();
  const bindings = { ...env, ADMIN_ACCOUNT_ID: owner.id };
  const marker = visitor().replace(/-/g, "").slice(0, 10);
  const accounts = (["registered", "guest"] as const).flatMap((kind) =>
    Array.from({ length: 51 }, (_, i) => ({
      id: `${marker}_${kind}_${i}`,
      name: `一覧_${marker}_${kind}_${i}`,
      username: i
        ? kind === "guest"
          ? `guest_${marker}${String(i).padStart(4, "0")}`
          : `a_${marker}_${i}`
        : null,
      at: Date.parse("2001-01-01T23:59:59.354+09:00") + Math.floor(i / 2),
      i,
      kind,
    })),
  );
  await env.APP_DB.batch(
    accounts.map(({ id, name, username, at, i, kind }) =>
      env.APP_DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, username, profileCompleted, isAnonymous) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        name,
        `${marker}${kind}${i}@example.test`,
        i % 2 ? new Date(at).toISOString() : at,
        at,
        username,
        i ? 1 : 0,
        kind === "guest" ? 1 : i % 2 ? 0 : null,
      ),
    ),
  );
  const request = (suffix: string) =>
    fetchWith(bindings, `/api/admin/users?search=${marker}${suffix}`, {
      headers: { Cookie: owner.cookie },
    });
  for (const kind of ["registered", "guest"] as const) {
    const response = await request(`&kind=${kind}`);
    expect(response.status).toBe(200);
    const first = adminUsersSchema.parse(await response.json());
    expect(first.users).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const next = adminUsersSchema.parse(
      await (await request(`&kind=${kind}&cursor=${encodeURIComponent(first.nextCursor!)}`)).json(),
    );
    expect(next.users).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    const users = [...first.users, ...next.users];
    expect(users.map((user) => [user.name, user.createdAtMs])).toEqual(
      accounts
        .filter((user) => user.kind === kind)
        .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
        .map((user) => [user.name, user.at]),
    );
    expect(users.filter((u) => !u.profileCompleted)).toHaveLength(1);
    expect(users.every((user) => Boolean(user.isGuest) === (kind === "guest"))).toBe(true);
    expect(JSON.stringify(users)).not.toContain("email");
    const match = accounts.find((user) => user.kind === kind && user.i === 1)!;
    const searchResponse = await fetchWith(
      bindings,
      `/api/admin/users?kind=${kind}&search=${encodeURIComponent(`@${match.username}`)}`,
      { headers: { Cookie: owner.cookie } },
    );
    const found = adminUsersSchema.parse(await searchResponse.json()).users;
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((user) => user.username?.includes(match.username!))).toBe(true);
  }
  const defaultPage = adminUsersSchema.parse(await (await request("")).json());
  expect(defaultPage.users).toHaveLength(50);
  expect(defaultPage.users.every((user) => !user.isGuest)).toBe(true);
  for (const kind of ["registered", "guest"] as const) {
    const deleted = accounts.find((user) => user.kind === kind && user.i === 50)!;
    await env.APP_DB.prepare(
      "INSERT INTO deleted_accounts(id, requested_at_ms, receipt_hash) VALUES (?, ?, ?)",
    )
      .bind(deleted.id, Date.now(), visitor())
      .run();
    const remaining = adminUsersSchema.parse(await (await request(`&kind=${kind}`)).json());
    expect(remaining.users).toHaveLength(50);
    expect(remaining.nextCursor).toBeNull();
    expect(remaining.users.some((user) => user.name === deleted.name)).toBe(false);
  }
  expect((await request("&cursor=bad")).status).toBe(400);
  expect((await request("&kind=unknown")).status).toBe(400);
});

test("新規登録は両日時形式を日本時間で集計し、計測開始前・期間外・本人・テストを除外する", async () => {
  const coverage = Date.parse("2011-01-31T23:59:59.500+09:00");
  const midnight = Date.parse("2011-02-01T00:00:00+09:00");
  const saved = await env.APP_DB.prepare(
    "SELECT value FROM analytics_metadata WHERE key = 'collected_from'",
  ).first<{ value: number }>();
  const accounts = await Promise.all(Array.from({ length: 8 }, () => accountFixture()));
  const dates = [
    coverage - 1,
    coverage,
    midnight,
    midnight + 354,
    midnight + 86400000,
    midnight,
    midnight,
    midnight,
  ];
  try {
    await env.APP_DB.batch([
      env.APP_DB.prepare(
        "INSERT OR REPLACE INTO analytics_metadata (key, value) VALUES ('collected_from', ?)",
      ).bind(coverage),
      ...accounts.map((account, index) =>
        env.APP_DB.prepare(
          "UPDATE user SET createdAt = ?, isTestUser = ?, isAnonymous = ? WHERE id = ?",
        ).bind(
          index === 2 ? dates[index] : new Date(dates[index]).toISOString(),
          index === 6 ? 1 : 0,
          index === 7 ? 1 : 0,
          account.id,
        ),
      ),
    ]);
    const bindings = { ...env, ADMIN_ACCOUNT_ID: accounts[5].id };
    const period = { ...query, from: "2011-01-31", to: "2011-02-01" };
    const daily = await readAnalytics(bindings, period);
    expect(daily.summary.newUsers).toBe(3);
    expect(daily.buckets.map(({ period, metrics }) => [period, metrics.newUsers])).toEqual([
      ["2011-01-31", 1],
      ["2011-02-01", 2],
    ]);
    const monthly = await readAnalytics(bindings, { ...period, bucket: "month" });
    expect(monthly.buckets.map(({ period, metrics }) => [period, metrics.newUsers])).toEqual([
      ["2011-01", 1],
      ["2011-02", 2],
    ]);
    expect(
      (await readAnalytics(bindings, { ...period, includeInternal: "true" })).summary.newUsers,
    ).toBe(5);
  } finally {
    await env.APP_DB.batch([
      saved
        ? env.APP_DB.prepare(
            "UPDATE analytics_metadata SET value = ? WHERE key = 'collected_from'",
          ).bind(saved.value)
        : env.APP_DB.prepare("DELETE FROM analytics_metadata WHERE key = 'collected_from'"),
      ...accounts.map((account) =>
        env.APP_DB.prepare("DELETE FROM user WHERE id = ?").bind(account.id),
      ),
    ]);
  }
});

test("再送と遅延した開始記録は確定済みの終局を上書きしない", async () => {
  const match = record(Date.now() - 120000);
  await writeAnalyticsMatch(env.APP_DB, match);
  await writeAnalyticsMatch(env.APP_DB, { ...match, status: "playing", endedAtMs: null });
  await writeAnalyticsMatch(env.APP_DB, { ...match, status: "abandoned", endedAtMs: Date.now() });
  expect(
    await env.APP_DB.prepare("SELECT status, ended_at_ms FROM analytics_matches WHERE id = ?")
      .bind(match.id)
      .first(),
  ).toEqual({ status: "completed", ended_at_ms: match.endedAtMs });
});

test("実対局の開始とルール上の終局を既存の棋譜と同じUUIDで計測する", async () => {
  const setup = await matchSetup();
  try {
    await matchStart(setup);
    const active = await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_, state) =>
      state.storage.kv.get<AnalyticsMatch>(analyticsActiveKey)!,
    );
    expect(active).toMatchObject({ status: "playing", game: "four-reversi", cpuCount: 0 });
    expect(active.participants[0].accountId).toBe(setup.user.id);
    for (const membership of setup.memberships.slice(0, 3)) await matchLeave(setup.id, membership);
    await vi.waitFor(async () =>
      expect(
        await env.APP_DB.prepare("SELECT status FROM analytics_matches WHERE id = ?")
          .bind(active.id)
          .first(),
      ).toEqual({ status: "completed" }),
    );
    await vi.waitFor(async () =>
      expect(
        await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(active.id).first(),
      ).toEqual({ id: active.id }),
    );
  } finally {
    for (const client of matchClients.splice(0)) client.close();
  }
});

for (const game of ["four-reversi", "four-shogi"] as const)
  test(`${game}: 未決着の閉鎖とD1障害・番号再利用後の計測再送`, async () => {
    const browser = visitor();
    const created = createRoomContract.response.parse(
      await (
        await fetchWith(env, "/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie(browser) },
          body: JSON.stringify({ name: "計測", game, mode: "singles", quickPlay: true }),
        })
      ).json(),
    );
    const stub = env.GAME_ROOM.getByName(created.room.id);
    const match = record(Date.now() - 10000, {
      game,
      status: "playing",
      endedAtMs: null,
      participants: [
        {
          playerId: created.membership.playerId,
          accountId: null,
          visitorId: browser,
          isTest: false,
        },
      ],
    });
    await env.APP_DB.prepare(
      `CREATE TRIGGER reject_analytics BEFORE INSERT ON analytics_matches WHEN NEW.id = '${match.id}' BEGIN SELECT RAISE(ABORT, 'unavailable'); END`,
    ).run();
    try {
      await runInDurableObject(stub, (_, state) => {
        state.storage.kv.put(analyticsActiveKey, match);
        state.storage.kv.put(analyticsPendingPrefix + match.id, {
          record: match,
          revision: 1,
          // 自動Alarmにrev1を拾わせず、閉鎖で作るrev2の保存失敗から検証します。
          retryAtMs: Date.now() + 60000,
        } satisfies AnalyticsJob);
      });
      expect(
        (
          await fetchWith(env, `/api/rooms/${created.room.id}/leave`, {
            method: "POST",
            headers: { Authorization: `Bearer ${created.membership.token}` },
          })
        ).status,
      ).toBe(204);
      await vi.waitFor(async () =>
        expect(
          await runInDurableObject(stub, (_, state) =>
            state.storage.kv.get<AnalyticsJob>(analyticsPendingPrefix + match.id),
          ),
        ).toMatchObject({ revision: 2, record: { status: "abandoned" } }),
      );
      await vi.waitFor(async () =>
        expect(
          await runInDurableObject(
            stub,
            (_, state) =>
              state.storage.kv.get<AnalyticsJob>(analyticsPendingPrefix + match.id)?.retryAtMs,
          ),
        ).toBeGreaterThan(Date.now()),
      );
      expect(await stub.getRoom()).toBeNull();
    } finally {
      await env.APP_DB.prepare("DROP TRIGGER reject_analytics").run();
    }
    const reused = await stub.createRoom(
      roomSchema.parse({
        ...created.room,
        instanceId: visitor(),
        players: created.room.players.map((p) => ({ ...p, id: visitor() })),
      }),
      visitor(),
    );
    expect(reused?.instanceId).not.toBe(created.room.instanceId);
    await runInDurableObject(stub, async (_, state) => {
      const job = state.storage.kv.get<AnalyticsJob>(analyticsPendingPrefix + match.id)!;
      state.storage.kv.put(analyticsPendingPrefix + match.id, {
        ...job,
        retryAtMs: Date.now() - 1,
      });
      await state.storage.setAlarm(Date.now() + 60000);
    });
    await runDurableObjectAlarm(stub);
    await vi.waitFor(async () =>
      expect(
        await env.APP_DB.prepare("SELECT status FROM analytics_matches WHERE id = ?")
          .bind(match.id)
          .first(),
      ).toEqual({ status: "abandoned" }),
    );
  });

test("不正な期間は400で、集計障害は0件にせず503を返す", async () => {
  const owner = await accountFixture();
  const bindings = { ...env, ADMIN_ACCOUNT_ID: owner.id };
  const response = await fetchWith(bindings, "/api/admin/analytics?from=2001-02-30&to=2001-03-01", {
    headers: { Cookie: owner.cookie },
  });
  expect(response.status).toBe(400);
  const valid = await fetchWith(bindings, "/api/admin/analytics?from=1990-01-01&to=1990-01-01", {
    headers: { Cookie: owner.cookie },
  });
  expect(adminAnalyticsSchema.parse(await valid.json()).summary.started).toBe(0);
  const unavailable = {
    prepare: env.APP_DB.prepare.bind(env.APP_DB),
    batch: async () => {
      throw new Error("aggregate unavailable");
    },
  } as unknown as D1Database;
  const failed = await fetchWith(
    { ...bindings, APP_DB: unavailable },
    "/api/admin/analytics?from=1990-01-01&to=1990-01-01",
    { headers: { Cookie: owner.cookie } },
  );
  expect(failed.status).toBe(503);
  expect(await failed.json()).not.toHaveProperty("summary");
});

test("将棋の実対局でも人間とブラウザの開始時情報を保存し、終局へ進める", async () => {
  const owner = await accountFixture();
  const browser = visitor();
  const created = createRoomContract.response.parse(
    await (
      await fetchWith(env, "/api/rooms", {
        method: "POST",
        headers: { ...owner.headers, Cookie: `${owner.cookie}; ${cookie(browser)}` },
        body: JSON.stringify({ game: "four-shogi", mode: "singles", quickPlay: false }),
      })
    ).json(),
  );
  const memberships = [created.membership];
  const sockets: WebSocket[] = [];
  const stub = env.GAME_ROOM.getByName(created.room.id);
  try {
    for (let i = 1; i < 4; i++) {
      const response = await fetchWith(env, `/api/rooms/${created.room.id}/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie(visitor()) },
        body: JSON.stringify({ name: "ゲスト" }),
      });
      const data = (await response.json()) as { membership: typeof created.membership };
      memberships.push(data.membership);
    }
    for (const membership of memberships) {
      const response = await fetchWith(env, `/api/rooms/${created.room.id}/ws`, {
        headers: { Upgrade: "websocket" },
      });
      const socket = response.webSocket!;
      const auth = new Promise<void>((resolve) =>
        socket.addEventListener("message", (event) => {
          if (JSON.parse(String(event.data)).type === "room.authenticated") resolve();
        }),
      );
      socket.accept();
      sockets.push(socket);
      socket.send(JSON.stringify({ type: "room.auth", token: membership.token }));
      await auth;
      socket.send(JSON.stringify({ type: "room.ready.set", ready: true }));
    }
    await vi.waitFor(async () =>
      expect((await stub.getRoom())?.players.every((p) => p.ready)).toBe(true),
    );
    sockets[0].send(JSON.stringify({ type: "room.game.start" }));
    await vi.waitFor(async () => expect((await stub.getRoom())?.status).toBe("playing"));
    const active = await runInDurableObject(stub, (_, state) =>
      state.storage.kv.get<AnalyticsMatch>(analyticsActiveKey)!,
    );
    expect(active).toMatchObject({ game: "four-shogi", status: "playing", cpuCount: 0 });
    expect(active.participants[0]).toMatchObject({ accountId: owner.id, visitorId: browser });
    expect(active.participants.every((p) => p.visitorId !== null)).toBe(true);
    for (const membership of memberships.slice(1))
      await fetchWith(env, `/api/rooms/${created.room.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${membership.token}` },
      });
    await vi.waitFor(async () =>
      expect(
        await env.APP_DB.prepare("SELECT status FROM analytics_matches WHERE id = ?")
          .bind(active.id)
          .first(),
      ).toEqual({ status: "completed" }),
    );
  } finally {
    for (const socket of sockets) socket.close();
  }
});

test("指定した2つの本人アカウントだけを許可し、不正な配列では旧設定へフォールバックしない", async () => {
  const owners = [await accountFixture(), await accountFixture()];
  const other = await accountFixture();
  const bindings = {
    ...env,
    ADMIN_ACCOUNT_ID: other.id,
    ADMIN_ACCOUNT_IDS: JSON.stringify([owners[0].id, owners[1].id, owners[0].id]),
    ASSETS: {
      fetch: async (request: Request) => new Response(new URL(request.url).pathname),
    } as Fetcher,
  };
  for (const owner of owners)
    for (const path of ["/api/admin/session", "/admin/users"])
      expect((await fetchWith(bindings, path, { headers: { Cookie: owner.cookie } })).status).toBe(
        200,
      );
  for (const path of ["/api/admin/session", "/admin/users"])
    expect((await fetchWith(bindings, path, { headers: { Cookie: other.cookie } })).status).toBe(
      403,
    );
  for (const value of ["", "[]", "[1]", '[""]', "{", JSON.stringify([owners[0].id, " "])])
    expect(
      (
        await fetchWith({ ...bindings, ADMIN_ACCOUNT_IDS: value }, "/api/admin/session", {
          headers: { Cookie: other.cookie },
        })
      ).status,
    ).toBe(503);
});

test("複数の本人アカウントを閲覧・滞在・対局・登録から除外し、一般利用者との混在対局は残す", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2002-01-31T12:00:00+09:00"));
  const people = [await accountFixture(), await accountFixture(), await accountFixture()];
  const at = Date.parse("2002-01-01T12:00:00+09:00");
  await env.APP_DB.prepare("INSERT OR REPLACE INTO analytics_metadata VALUES ('collected_from',?)")
    .bind(at)
    .run();
  const participants = people.map((person) => ({
    playerId: visitor(),
    accountId: person.id,
    visitorId: visitor(),
    isTest: false,
  }));
  for (const [index, person] of people.entries()) {
    const viewId = visitor();
    await env.APP_DB.batch([
      env.APP_DB.prepare("UPDATE user SET createdAt = ? WHERE id = ?").bind(at, person.id),
      env.APP_DB.prepare(
        "INSERT INTO analytics_pageviews (id, visitor_id, account_id, page, game, started_at_ms) VALUES (?, ?, ?, 'lobby', 'four-reversi', ?)",
      ).bind(viewId, participants[index].visitorId, person.id, at),
      env.APP_DB.prepare(
        "INSERT INTO analytics_dwell (view_id, day, milliseconds) VALUES (?, '2002-01-01', 1000)",
      ).bind(viewId),
    ]);
  }
  for (const person of participants.slice(0, 2))
    await writeAnalyticsMatch(env.APP_DB, record(at, { participants: [person] }));
  await writeAnalyticsMatch(env.APP_DB, record(at, { participants, cpuCount: 1 }));
  const period = { ...query, from: "2002-01-01", to: "2002-01-01" };
  const baseline = await readAnalytics(env, period);
  const bindings = {
    ...env,
    ADMIN_ACCOUNT_IDS: JSON.stringify(people.slice(0, 2).map((p) => p.id)),
  };
  const excluded = await readAnalytics(bindings, period);
  expect(excluded.summary).toMatchObject({
    visitors: 1,
    pageViews: 1,
    dwellMs: 1000,
    newUsers: 1,
    started: 1,
    completed: 1,
    registeredActive: 1,
    registeredParticipations: 1,
    participationMs: 60000,
    conversionEligible: 1,
    converted: 1,
    registeredRetentionEligible: 1,
  });
  expect(excluded.totalUsers).toBe(baseline.totalUsers - 2);
  const included = await readAnalytics(bindings, { ...period, includeInternal: "true" });
  expect(included.summary).toMatchObject({
    visitors: 3,
    pageViews: 3,
    dwellMs: 3000,
    newUsers: 3,
    started: 3,
    completed: 3,
    registeredActive: 3,
    registeredParticipations: 5,
    participationMs: 300000,
    conversionEligible: 3,
    converted: 3,
    registeredRetentionEligible: 3,
  });
});
