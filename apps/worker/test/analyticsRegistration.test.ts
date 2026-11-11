import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test, vi } from "vitest";
import worker from "../src/worker";
import {
  aggregateRegistrationAnalytics,
  readRegistrationAnalytics,
} from "../src/analytics/registrationAggregation";
import {
  rememberRegistrationAnalytics,
  completeRegistrationAnalytics,
  recordRegistrationEntry,
} from "../src/analytics/registration";
import { archiveAnalytics } from "../src/analytics/retention";
import { writeAnalyticsMatch } from "../src/analytics/store";
import { analyticsRetentionMs, legalVersion } from "@tetraboard/protocol/privacy";
import { accountFixture } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
const env = {
  ...bindings,
  APP_DB: (bindings as typeof bindings & { ANALYTICS_REGISTRATION_TEST_DB: D1Database })
    .ANALYTICS_REGISTRATION_TEST_DB,
};
beforeAll(async () =>
  applyD1Migrations(
    env.APP_DB,
    (bindings as typeof bindings & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  ),
);
const context = { waitUntil: () => {} } as unknown as ExecutionContext;
const send = (path: string, init: RequestInit = {}, extra = {}) =>
  worker.fetch(
    new AcceptedGameRequest(`${env.APP_ORIGIN}/api${path}`, init),
    { ...env, ...extra },
    context,
  );

// 修正前は新APIが404となり、権限確認と固定リンクの取得ができません。
test("計測リンクAPIは管理者だけが固定1〜4を取得できる", async () => {
  const owner = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const extra = { ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  expect((await send("/admin/tracking-links", {}, extra)).status).toBe(401);
  const response = await send(
    "/admin/tracking-links",
    { headers: { Cookie: owner.cookie } },
    extra,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { links: { id: number; label: string }[] };
  expect(body.links.slice(0, 4)).toEqual(
    [
      { id: 1, label: "開発者Xプロフィール" },
      { id: 2, label: "TetraBoard公式Xプロフィール" },
      { id: 3, label: "開発者X投稿" },
      { id: 4, label: "TetraBoard公式X投稿" },
    ].map((x) => expect.objectContaining(x)),
  );
});

// 修正前はshortUtmが未対応で400となり、訪問に短縮番号を帰属できません。
test("短縮UTMを受け付け、旧UTMより優先して訪問へ保存する", async () => {
  const id = crypto.randomUUID(),
    visitor = crypto.randomUUID();
  const response = await send("/analytics/pageviews", {
    method: "POST",
    headers: {
      Origin: env.APP_ORIGIN,
      Cookie: `tetraboard-2026.analytics=${visitor}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id,
      page: "general-lobby",
      game: null,
      acquisition: {
        referrer: "direct",
        source: "legacy",
        medium: "legacy",
        campaign: "legacy",
        shortUtm: "1",
      },
    }),
  });
  expect(response.status).toBe(204);
  expect(
    await env.APP_DB.prepare(
      "SELECT utm_link_id,utm_source,utm_medium,utm_campaign FROM analytics_sessions WHERE id=?",
    )
      .bind(id)
      .first(),
  ).toEqual({
    utm_link_id: 1,
    utm_source: "link-1",
    utm_medium: "social",
    utm_campaign: "profile",
  });
});

// 修正前は入口の限定イベントが404となり、登録導線の起点を記録できません。
test("登録入口は限定形式を保存し、再送で重複しない", async () => {
  const id = crypto.randomUUID(),
    visitor = crypto.randomUUID();
  const init = {
    method: "POST",
    headers: {
      Origin: env.APP_ORIGIN,
      Cookie: `tetraboard-2026.analytics=${visitor}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, entry: "account-menu", game: null }),
  };
  expect((await send("/analytics/registration", init)).status).toBe(204);
  expect((await send("/analytics/registration", init)).status).toBe(204);
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) FROM analytics_registration_events WHERE flow_id=? AND stage='entry'",
    )
      .bind(id)
      .first("COUNT(*)"),
  ).toBe(1);
});

const headers = (cookie: string) => ({
  Cookie: cookie,
  Origin: env.APP_ORIGIN,
  "Content-Type": "application/json",
});
const query = {
  from: "2026-01-01",
  to: "2027-12-31",
  game: "all",
  includeInternal: "true",
  bucket: "day",
} as const;
test("追加番号は同時発行でも再利用せず、意味を固定して表示名とアーカイブだけ更新する", async () => {
  const owner = await accountFixture(true, crypto.randomUUID(), env.APP_DB),
    other = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const extra = { ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  expect(
    (await send("/admin/tracking-links", { headers: headers(other.cookie) }, extra)).status,
  ).toBe(403);
  expect(
    (
      await send(
        "/admin/tracking-links",
        { method: "POST", headers: { Cookie: owner.cookie }, body: "{}" },
        extra,
      )
    ).status,
  ).toBe(403);
  const create = () =>
    send(
      "/admin/tracking-links",
      {
        method: "POST",
        headers: headers(owner.cookie),
        body: JSON.stringify({ label: "施策", medium: "X", campaign: "追加投稿" }),
      },
      extra,
    );
  const responses = await Promise.all([create(), create()]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const links = await Promise.all(responses.map((r) => r.json() as Promise<{ id: number }>));
  expect(new Set(links.map((row) => row.id)).size).toBe(2);
  expect(links.every((row) => row.id >= 5)).toBe(true);
  const id = links[0]!.id;
  const patch = await send(
    `/admin/tracking-links/${id}`,
    {
      method: "PATCH",
      headers: headers(owner.cookie),
      body: JSON.stringify({ label: "表示名変更", archived: true }),
    },
    extra,
  );
  expect(patch.status).toBe(200);
  expect(await patch.json()).toMatchObject({
    id,
    label: "表示名変更",
    medium: "X",
    campaign: "追加投稿",
    archived: true,
  });
  expect(
    (
      await send(
        `/admin/tracking-links/${id}`,
        {
          method: "PATCH",
          headers: headers(owner.cookie),
          body: JSON.stringify({ medium: "別の意味" }),
        },
        extra,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await send(
        `/admin/tracking-links/1`,
        {
          method: "PATCH",
          headers: headers(owner.cookie),
          body: JSON.stringify({ label: "別の意味" }),
        },
        extra,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await send(
        `/admin/tracking-links/${id}`,
        { method: "DELETE", headers: headers(owner.cookie) },
        extra,
      )
    ).status,
  ).toBe(404);
  const visitor = crypto.randomUUID(),
    viewId = crypto.randomUUID();
  expect(
    (
      await send("/analytics/pageviews", {
        method: "POST",
        headers: headers(`tetraboard-2026.analytics=${visitor}`),
        body: JSON.stringify({
          id: viewId,
          page: "general-lobby",
          game: null,
          acquisition: {
            referrer: "direct",
            source: null,
            medium: null,
            campaign: null,
            shortUtm: String(id),
          },
        }),
      })
    ).status,
  ).toBe(204);
  expect(
    await env.APP_DB.prepare(
      "SELECT utm_link_id,utm_medium,utm_campaign FROM analytics_sessions WHERE id=?",
    )
      .bind(viewId)
      .first(),
  ).toEqual({ utm_link_id: id, utm_medium: "X", utm_campaign: "追加投稿" });
});

test("短縮番号の不正・未登録は不明とし、番号なしの旧UTMと実参照元、訪問開始時の帰属を維持する", async () => {
  for (const short of ["", "01", "-1", "x", "999999999", null, undefined]) {
    const visitor = crypto.randomUUID(),
      id = crypto.randomUUID();
    const response = await send("/analytics/pageviews", {
      method: "POST",
      headers: headers(`tetraboard-2026.analytics=${visitor}`),
      body: JSON.stringify({
        id,
        page: "lobby",
        game: "reversi",
        acquisition: {
          referrer: "google.com",
          source: "legacy",
          medium: "old",
          campaign: "old",
          ...(short !== undefined ? { shortUtm: short } : {}),
        },
      }),
    });
    expect(response.status).toBe(204);
    expect(
      await env.APP_DB.prepare(
        "SELECT utm_link_id,utm_source,referrer_class FROM analytics_sessions WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({
      utm_link_id: null,
      utm_source: short === undefined ? "legacy" : null,
      referrer_class: "search",
    });
  }
  const visitor = crypto.randomUUID(),
    first = crypto.randomUUID(),
    second = crypto.randomUUID();
  for (const [id, shortUtm] of [
    [first, "1"],
    [second, "2"],
  ]) {
    expect(
      (
        await send("/analytics/pageviews", {
          method: "POST",
          headers: headers(`tetraboard-2026.analytics=${visitor}`),
          body: JSON.stringify({
            id,
            page: "lobby",
            game: "reversi",
            acquisition: {
              referrer: "google.com",
              source: null,
              medium: null,
              campaign: null,
              shortUtm,
            },
          }),
        })
      ).status,
    ).toBe(204);
  }
  expect(
    await env.APP_DB.prepare("SELECT utm_link_id FROM analytics_sessions WHERE visitor_id=?")
      .bind(visitor)
      .first("utm_link_id"),
  ).toBe(1);
  const match = crypto.randomUUID(),
    now = Date.now();
  await writeAnalyticsMatch(env.APP_DB, {
    id: match,
    game: "reversi",
    mode: "singles",
    startedAtMs: now,
    endedAtMs: now + 1000,
    status: "completed",
    cpuCount: 1,
    participants: [{ playerId: "guest", accountId: null, visitorId: visitor, isTest: false }],
  });
  expect(
    await env.APP_DB.prepare("SELECT utm_link_id FROM analytics_participants WHERE match_id=?")
      .bind(match)
      .first("utm_link_id"),
  ).toBe(1);
  const flow = crypto.randomUUID();
  await send("/analytics/registration", {
    method: "POST",
    headers: headers(`tetraboard-2026.analytics=${visitor}`),
    body: JSON.stringify({ id: flow, entry: "room-result", game: "reversi" }),
  });
  expect(
    await env.APP_DB.prepare(
      "SELECT utm_link_id,entry,referrer_class FROM analytics_registration_flows WHERE id=?",
    )
      .bind(flow)
      .first(),
  ).toEqual({ utm_link_id: 1, entry: "room-result", referrer_class: "search" });
});

test("登録イベントは自由な段階・URL・別ブラウザの再送を受け付けず、入口の本人を固定する", async () => {
  const id = crypto.randomUUID(),
    visitor = crypto.randomUUID();
  for (const extra of [
    { entry: "arbitrary" },
    { stage: "registered" },
    { url: "https://private.test/?token=SECRET" },
  ]) {
    expect(
      (
        await send("/analytics/registration", {
          method: "POST",
          headers: headers(`tetraboard-2026.analytics=${visitor}`),
          body: JSON.stringify({ id, entry: "login-page", game: null, ...extra }),
        })
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await send("/analytics/registration", {
        method: "POST",
        headers: { ...headers(""), Origin: "https://other.test" },
        body: JSON.stringify({ id, entry: "login-page", game: null }),
      })
    ).status,
  ).toBe(403);
  for (const cookie of [visitor, crypto.randomUUID()])
    await send("/analytics/registration", {
      method: "POST",
      headers: headers(`tetraboard-2026.analytics=${cookie}`),
      body: JSON.stringify({ id, entry: "login-page", game: null }),
    });
  expect(
    await env.APP_DB.prepare("SELECT visitor_id FROM analytics_registration_flows WHERE id=?")
      .bind(id)
      .first("visitor_id"),
  ).toBe(visitor);
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS count FROM analytics_registration_events WHERE flow_id=?",
    )
      .bind(id)
      .first("count"),
  ).toBe(1);
});

test("5分集計は入口単位で重複を防ぎ、失敗時に前回値を保ち、90日削除後も匿名件数を維持する", async () => {
  const id = crypto.randomUUID(),
    visitor = crypto.randomUUID(),
    now = Date.now();
  await recordRegistrationEntry(
    env,
    { id, entry: "guest-account", game: null },
    visitor,
    null,
    now,
  );
  await aggregateRegistrationAnalytics(env, now);
  const own = (data: Awaited<ReturnType<typeof readRegistrationAnalytics>>) =>
    data.rows
      .filter((row) => row.entry === "guest-account" && row.stage === "entry")
      .reduce((sum, row) => sum + row.count, 0);
  const before = await readRegistrationAnalytics(env, query, now);
  expect(own(before)).toBe(1);
  await recordRegistrationEntry(
    env,
    { id, entry: "guest-account", game: null },
    visitor,
    null,
    now + 1,
  );
  await aggregateRegistrationAnalytics(env, now + 1);
  expect(own(await readRegistrationAnalytics(env, query, now + 1))).toBe(1);
  const next = crypto.randomUUID();
  await recordRegistrationEntry(
    env,
    { id: next, entry: "guest-account", game: null },
    visitor,
    null,
    now + 2,
  );
  const failed = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          target.batch([...statements, target.prepare("SELECT * FROM missing_registration_table")]);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    aggregateRegistrationAnalytics({ ...env, APP_DB: failed }, now + 2),
  ).rejects.toThrow();
  expect(own(await readRegistrationAnalytics(env, query, now + 2))).toBe(1);
  await aggregateRegistrationAnalytics(env, now + 3);
  expect(own(await readRegistrationAnalytics(env, query, now + 3))).toBe(2);
  const later = now + analyticsRetentionMs;
  await archiveAnalytics(env, later);
  await aggregateRegistrationAnalytics(env, later);
  expect(own(await readRegistrationAnalytics(env, query, later))).toBe(2);
  await archiveAnalytics(env, later + 3);
  await archiveAnalytics(env, later + 3);
  await aggregateRegistrationAnalytics(env, later + 4);
  expect(own(await readRegistrationAnalytics(env, query, later + 4))).toBe(2);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_registration_flows WHERE id IN(?,?)")
      .bind(id, next)
      .first(),
  ).toBeNull();
  expect((await readRegistrationAnalytics(env, query, later + 300005)).status).toBe("delayed");
});

test("OAuthの取消・改ざん・失敗・期限切れは成功にせず、完了後の別ログインは新しい手続きにする", async () => {
  const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB),
    visitor = crypto.randomUUID();
  const cookie = `${user.cookie}; tetraboard-2026.analytics=${visitor}`;
  const input = { id: crypto.randomUUID(), entry: "account-link" as const, game: null };
  const state = crypto.randomUUID();
  await rememberRegistrationAnalytics(
    new Request(env.APP_ORIGIN, { headers: headers(cookie) }),
    env,
    state,
    "google",
    input,
  );
  const callback = (extra = "", provider = "google") =>
    new Request(`${env.APP_ORIGIN}/api/auth/callback/${provider}?state=${state}${extra}`);
  const success = new Response(null, {
    status: 302,
    headers: { "Set-Cookie": `${user.cookie}; Path=/; HttpOnly`, Location: "/account" },
  });
  const events = async () =>
    (
      await env.APP_DB.prepare(
        "SELECT stage FROM analytics_registration_events WHERE flow_id=? ORDER BY stage",
      )
        .bind(input.id)
        .all<{ stage: string }>()
    ).results.map((row) => row.stage);
  await completeRegistrationAnalytics(callback("&error=access_denied"), success, env, true);
  await completeRegistrationAnalytics(
    callback(),
    new Response(null, { status: 503, headers: success.headers }),
    env,
    true,
  );
  await completeRegistrationAnalytics(
    callback(),
    new Response(null, { status: 302, headers: { "Set-Cookie": `${user.cookie}tampered` } }),
    env,
    true,
  );
  await completeRegistrationAnalytics(callback("", "discord"), success, env, true);
  expect(await events()).toEqual(["entry", "oauth_start"]);
  await completeRegistrationAnalytics(callback(), success, env, false);
  await completeRegistrationAnalytics(callback(), success, env, true);
  expect(await events()).toEqual(["entry", "existing_login", "oauth_start", "oauth_success"]);
  const nextState = crypto.randomUUID();
  await rememberRegistrationAnalytics(
    new Request(env.APP_ORIGIN, { headers: headers(cookie) }),
    env,
    nextState,
    "google",
    input,
  );
  await completeRegistrationAnalytics(
    new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=${nextState}`),
    success,
    env,
    false,
  );
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS count FROM analytics_registration_flows WHERE target_account_id=? AND entry='account-link'",
    )
      .bind(user.id)
      .first("count"),
  ).toBe(2);
  const expired = { id: crypto.randomUUID(), entry: "login-page" as const, game: null };
  const expiredState = crypto.randomUUID();
  await rememberRegistrationAnalytics(
    new Request(env.APP_ORIGIN, { headers: headers(cookie) }),
    env,
    expiredState,
    "google",
    expired,
  );
  await env.APP_DB.prepare(
    "UPDATE analytics_registration_attempts SET expires_at_ms=1 WHERE flow_id=?",
  )
    .bind(expired.id)
    .run();
  await completeRegistrationAnalytics(
    new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=${expiredState}`),
    success,
    env,
    true,
  );
  expect(
    await env.APP_DB.prepare(
      "SELECT 1 FROM analytics_registration_events WHERE flow_id=? AND stage='registered'",
    )
      .bind(expired.id)
      .first(),
  ).toBeNull();
});

test("プロフィール計測が保存できなくても本人の設定は成功し、計測済みと偽らない", async () => {
  const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
  const flow = { id: crypto.randomUUID(), entry: "login-page" as const, game: null };
  const state = crypto.randomUUID(),
    request = new Request(env.APP_ORIGIN, { headers: headers(user.cookie) });
  await rememberRegistrationAnalytics(request, env, state, "google", flow);
  await completeRegistrationAnalytics(
    new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=${state}`),
    new Response(null, {
      status: 302,
      headers: { "Set-Cookie": user.cookie, Location: "/account/setup" },
    }),
    env,
    false,
  );
  await env.APP_DB.prepare(
    "CREATE TRIGGER fail_profile_analytics BEFORE INSERT ON analytics_registration_events WHEN NEW.stage='profile_complete' BEGIN SELECT RAISE(ABORT,'measurement_unavailable'); END",
  ).run();
  try {
    const form = new FormData();
    form.set("name", "設定成功");
    form.set("username", `track_${user.id.slice(0, 8)}`);
    form.set("avatarAction", "keep");
    form.set("consentVersion", legalVersion);
    const encoded = new Request(`${env.APP_ORIGIN}/api/account/setup`, {
      method: "POST",
      headers: { Cookie: user.cookie, Origin: env.APP_ORIGIN },
      body: form,
    });
    const response = await send("/account/setup", {
      method: "POST",
      headers: encoded.headers,
      body: await encoded.arrayBuffer(),
    });
    expect(response.status).toBe(200);
    expect(
      await env.APP_DB.prepare("SELECT profileCompleted FROM user WHERE id=?")
        .bind(user.id)
        .first("profileCompleted"),
    ).toBe(1);
    expect(
      await env.APP_DB.prepare(
        "SELECT 1 FROM analytics_registration_events WHERE flow_id=? AND stage='profile_complete'",
      )
        .bind(flow.id)
        .first(),
    ).toBeNull();
  } finally {
    await env.APP_DB.prepare("DROP TRIGGER fail_profile_analytics").run();
  }
});

test("退会で個別の導線を消し、古い入口とコールバックの遅延保存で復活しない", async () => {
  const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB),
    visitor = crypto.randomUUID();
  const flow = { id: crypto.randomUUID(), entry: "guest-account" as const, game: null },
    now = Date.now();
  const row = await env.APP_DB.prepare("SELECT * FROM user WHERE id=?").bind(user.id).first();
  await recordRegistrationEntry(
    env,
    flow,
    visitor,
    row as unknown as Parameters<typeof recordRegistrationEntry>[3],
    now,
  );
  const state = crypto.randomUUID();
  await rememberRegistrationAnalytics(
    new Request(env.APP_ORIGIN, {
      headers: headers(`${user.cookie}; tetraboard-2026.analytics=${visitor}`),
    }),
    env,
    state,
    "google",
    flow,
  );
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)",
  )
    .bind(user.id, now, crypto.randomUUID())
    .run();
  await recordRegistrationEntry(env, flow, visitor, null, now + 1);
  await completeRegistrationAnalytics(
    new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=${state}`),
    new Response(null, { status: 302, headers: { "Set-Cookie": user.cookie } }),
    env,
    true,
  );
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_registration_flows WHERE id=?")
      .bind(flow.id)
      .first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_registration_events WHERE flow_id=?")
      .bind(flow.id)
      .first(),
  ).toBeNull();
  await archiveAnalytics(env, now + analyticsRetentionMs + 1);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_registration_deleted_flows WHERE id=?")
      .bind(flow.id)
      .first(),
  ).toBeNull();
});

test("集計の取得は読み取りだけで、未認証・権限なしと障害を区別する", async () => {
  const owner = await accountFixture(true, crypto.randomUUID(), env.APP_DB),
    other = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const extra = { ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) },
    path = "/admin/analytics/registration?from=2026-11-01&to=2026-11-30";
  expect((await send(path, {}, extra)).status).toBe(401);
  expect((await send(path, { headers: headers(other.cookie) }, extra)).status).toBe(403);
  const response = await send(path, { headers: headers(owner.cookie) }, extra);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const sqls: string[] = [];
  const db = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          sqls.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await readRegistrationAnalytics({ ...env, APP_DB: db }, query);
  expect(
    sqls.every(
      (sql) =>
        !/(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET|sqlite_master|pragma_table_info)/i.test(
          sql,
        ),
    ),
  ).toBe(true);
  const unavailable = {
    prepare() {
      throw new Error("unavailable");
    },
  } as unknown as D1Database;
  expect(
    (await send(path, { headers: headers(owner.cookie) }, { ...extra, APP_DB: unavailable }))
      .status,
  ).toBe(503);
});

test("日本時間の入口日と成功日を別々に集計し、期間の起点を選べる", async () => {
  const before = Date.parse("2026-12-20T23:59:59+09:00"),
    after = before + 1000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(before);
  try {
    const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
    const flow = {
        id: crypto.randomUUID(),
        entry: "profile-edit" as const,
        game: "shogi" as const,
      },
      state = crypto.randomUUID();
    await rememberRegistrationAnalytics(
      new Request(env.APP_ORIGIN, { headers: headers(user.cookie) }),
      env,
      state,
      "google",
      flow,
    );
    clock.mockReturnValue(after);
    await completeRegistrationAnalytics(
      new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=${state}`),
      new Response(null, { status: 302, headers: { "Set-Cookie": user.cookie } }),
      env,
      false,
    );
    await aggregateRegistrationAnalytics(env, after);
    const entry = await readRegistrationAnalytics(
      env,
      { ...query, from: "2026-12-20", to: "2026-12-20", dateBasis: "entry" },
      after,
    );
    expect(
      entry.rows.find((row) => row.entry === "profile-edit" && row.stage === "oauth_success"),
    ).toMatchObject({ entryDay: "2026-12-20", day: "2026-12-21", count: 1 });
    const sameEventDay = await readRegistrationAnalytics(
      env,
      { ...query, from: "2026-12-20", to: "2026-12-20", dateBasis: "event" },
      after,
    );
    expect(
      sameEventDay.rows.some(
        (row) => row.entry === "profile-edit" && row.stage === "oauth_success",
      ),
    ).toBe(false);
    const nextEventDay = await readRegistrationAnalytics(
      env,
      { ...query, from: "2026-12-21", to: "2026-12-21", dateBasis: "event" },
      after,
    );
    expect(
      nextEventDay.rows.find(
        (row) => row.entry === "profile-edit" && row.stage === "oauth_success",
      ),
    ).toMatchObject({ entryDay: "2026-12-20", day: "2026-12-21", count: 1 });
    const internal = {
      ...env,
      ADMIN_ACCOUNT_IDS: JSON.stringify([
        user.id,
        ...Array.from({ length: 31 }, () => crypto.randomUUID()),
      ]),
    };
    await env.APP_DB.prepare("UPDATE analytics_registration_flows SET is_test=is_test WHERE id=?")
      .bind(flow.id)
      .run();
    await aggregateRegistrationAnalytics(internal, after + 1);
    expect(
      (
        await readRegistrationAnalytics(
          env,
          { ...query, from: "2026-12-20", to: "2026-12-20", includeInternal: "false" },
          after + 1,
        )
      ).rows.filter((row) => row.entry === "profile-edit"),
    ).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});
