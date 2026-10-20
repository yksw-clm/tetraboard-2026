import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
  analyticsSessionIdleMs,
  type AcquisitionInput,
  type AdminAnalyticsQuery,
} from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { readAcquisition } from "../src/analytics/acquisition";
import { archiveAnalytics } from "../src/analytics/retention";
import { writeAnalyticsMatch, type AnalyticsMatch } from "../src/analytics/store";
import { readAnalytics } from "../src/admin/metrics";
import { AcceptedGameRequest } from "./acceptedGameRequest";

const db = (env as typeof env & { ANALYTICS_ACQUISITION_TEST_DB: D1Database })
  .ANALYTICS_ACQUISITION_TEST_DB;
const bindings = { ...env, APP_DB: db },
  context = { waitUntil: () => {} } as unknown as ExecutionContext;
const base = Date.parse("2004-01-01T12:00:00+09:00");
const authenticationTime = Date.now();
let now = base;
const landing: AcquisitionInput = {
  referrer: "t.co",
  source: "X",
  medium: "social",
  campaign: "20040101_event",
};
const query: AdminAnalyticsQuery = {
  from: "2004-01-01",
  to: "2004-01-02",
  bucket: "day",
  game: "all",
  includeInternal: "false",
};
beforeAll(async () =>
  applyD1Migrations(
    db,
    (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  ),
);
beforeEach(async () => {
  now = base;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await db.exec(
    "DELETE FROM analytics_session_visits; DELETE FROM analytics_sessions; DELETE FROM analytics_dwell; DELETE FROM analytics_pageviews; DELETE FROM analytics_participants; DELETE FROM analytics_matches; DELETE FROM analytics_acquisition_daily; DELETE FROM analytics_daily",
  );
  await db
    .prepare("UPDATE analytics_metadata SET value=? WHERE key='acquisition_collected_from'")
    .bind(base - 3600000)
    .run();
});
afterEach(() => vi.restoreAllMocks());
async function post(
  path: string,
  visitor: string,
  data: unknown,
  accountCookie = "",
  ua = "Mozilla/5.0 (iPhone) Mobile",
) {
  return worker.fetch(
    new AcceptedGameRequest(`${origin}/api/analytics/${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: `tetraboard-2026.analytics=${visitor}; ${accountCookie}`,
        "User-Agent": ua,
      },
      body: JSON.stringify(data),
    }),
    bindings,
    context,
  );
}
async function view(
  visitor: string,
  acquisition: AcquisitionInput | undefined = landing,
  options: { id?: string; game?: "four-shogi" | "reversi"; cookie?: string } = {},
) {
  const id = options.id ?? crypto.randomUUID();
  const response = await post(
    "pageviews",
    visitor,
    {
      id,
      page: options.game ? "lobby" : "general-lobby",
      game: options.game ?? null,
      ...(acquisition ? { acquisition } : {}),
    },
    options.cookie,
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("Set-Cookie")).toBeNull();
  return id;
}
function match(visitors: string[], at = now): AnalyticsMatch {
  return {
    id: crypto.randomUUID(),
    game: "four-shogi",
    mode: "singles",
    startedAtMs: at,
    endedAtMs: null,
    status: "playing",
    cpuCount: 0,
    participants: visitors.map((visitorId) => ({
      playerId: crypto.randomUUID(),
      visitorId,
      accountId: null,
      isTest: false,
    })),
  };
}
const report = () => readAcquisition(bindings, query, now);
async function account() {
  vi.mocked(Date.now).mockReturnValue(authenticationTime);
  try {
    return await accountFixture(true, crypto.randomUUID(), db);
  } finally {
    vi.mocked(Date.now).mockImplementation(() => now);
  }
}

test("同時タブを1訪問にまとめ、参照元・UTMはランディングだけに保存する", async () => {
  const visitor = crypto.randomUUID();
  await Promise.all(Array.from({ length: 5 }, () => view(visitor)));
  now += 1000;
  await view(
    visitor,
    { referrer: "www.google.com", source: "different", medium: null, campaign: null },
    { game: "four-shogi" },
  );
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_sessions").first("n")).toBe(1);
  const session = await db.prepare("SELECT * FROM analytics_sessions").first();
  expect(session).toMatchObject({
    referrer_host: "t.co",
    referrer_class: "social",
    utm_source: "X",
    device: "mobile",
  });
  expect((await report()).summary.find((row) => row.dimension === "utm")).toMatchObject({
    value: "X",
    visits: 1,
  });
  const filtered = await readAcquisition(bindings, { ...query, game: "four-shogi" }, now);
  expect(filtered.summary.find((row) => row.dimension === "referrer")).toMatchObject({
    value: "social",
    visits: 1,
  });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_pageviews").first("n")).toBe(6);
});

test("30分の直前は継続、一致で新規とし、同じ閲覧IDの再送では訪問を復活させない", async () => {
  const visitor = crypto.randomUUID(),
    id = await view(visitor);
  now += analyticsSessionIdleMs - 1;
  await view(visitor);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_sessions").first("n")).toBe(1);
  now += analyticsSessionIdleMs;
  await view(visitor, landing, { id });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_sessions").first("n")).toBe(1);
  await view(visitor, { referrer: "direct", source: null, medium: null, campaign: null });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_sessions").first("n")).toBe(2);
  expect(
    (await report()).summary.find((row) => row.dimension === "referrer" && row.value === "direct")
      ?.visits,
  ).toBe(1);
});

test("前面滞在の増分は活動を更新し、同じ累積値の再送と期限後の送信では延長しない", async () => {
  const visitor = crypto.randomUUID(),
    id = await view(visitor);
  const data = { id, days: [{ day: "2004-01-01", milliseconds: 30000 }] };
  now += 30000;
  expect((await post("dwell", visitor, data)).status).toBe(204);
  expect(
    await db.prepare("SELECT last_activity_ms FROM analytics_sessions").first("last_activity_ms"),
  ).toBe(now);
  now += 1000;
  await post("dwell", visitor, data);
  expect(
    await db.prepare("SELECT last_activity_ms FROM analytics_sessions").first("last_activity_ms"),
  ).toBe(now - 1000);
  now += analyticsSessionIdleMs;
  await post("dwell", visitor, { id, days: [{ day: "2004-01-01", milliseconds: 31000 }] });
  expect(
    await db.prepare("SELECT last_activity_ms FROM analytics_sessions").first("last_activity_ms"),
  ).toBe(base + 30000);
});

test("UAやURL全文を保存せず、UTMをサーバーでも制限し、旧Webの欠測をdirectへ置き換えない", async () => {
  await view(crypto.randomUUID(), {
    referrer: "https://example.test/private?q=SECRET",
    source: "告知" + "A".repeat(65),
    medium: "/social?",
    campaign: "日本語",
  });
  const legacy = crypto.randomUUID();
  await post("pageviews", legacy, { id: crypto.randomUUID(), page: "general-lobby", game: null });
  const sessions = await db
    .prepare("SELECT * FROM analytics_sessions ORDER BY utm_source DESC")
    .all();
  expect(JSON.stringify(sessions.results)).not.toMatch(/SECRET|Mozilla|iPhone|private/);
  expect(sessions.results[0]).toMatchObject({
    referrer_host: null,
    referrer_class: null,
    utm_source: "A".repeat(64),
    utm_medium: "social",
    utm_campaign: null,
    device: "mobile",
  });
  expect(sessions.results[1]).toMatchObject({ referrer_class: null, device: null });
  expect((await report()).summary.find((row) => row.dimension === "referrer")).toMatchObject({
    value: "",
    visits: 2,
  });
});

test("各区分の開始対局を重複排除し、再訪・終局再送で開始時点の帰属を変えない", async () => {
  const visitors = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await view(visitors[0]!);
  await view(visitors[1]!);
  await view(visitors[2]!, {
    referrer: "www.google.com",
    source: "google",
    medium: "search",
    campaign: null,
  });
  now += 1000;
  const record = match(visitors);
  await writeAnalyticsMatch(db, record);
  let rows = (await report()).summary;
  expect(rows.find((row) => row.dimension === "referrer" && row.value === "social")).toMatchObject({
    visits: 2,
    started: 1,
  });
  expect(rows.find((row) => row.dimension === "referrer" && row.value === "search")).toMatchObject({
    visits: 1,
    started: 1,
  });
  expect(rows.find((row) => row.dimension === "device")).toMatchObject({
    value: "mobile",
    started: 1,
  });
  now += analyticsSessionIdleMs;
  await view(visitors[0]!, { referrer: "direct", source: "changed", medium: null, campaign: null });
  await writeAnalyticsMatch(db, { ...record, status: "completed", endedAtMs: now });
  rows = (await report()).summary;
  expect(rows.find((row) => row.dimension === "utm" && row.value === "changed")?.started).toBe(0);
  expect(rows.find((row) => row.dimension === "utm" && row.value === "X")?.started).toBe(1);
  expect((await readAnalytics(bindings, query)).summary).toMatchObject({
    pageViews: 4,
    started: 1,
    completed: 1,
  });
});

test("90日境界でIDを削除し、訪問と対局が別々に期限へ達しても日別・期間合計を維持する", async () => {
  const visitor = crypto.randomUUID();
  await view(visitor);
  now += 1000;
  await writeAnalyticsMatch(db, match([visitor]));
  const before = (await report()).summary;
  now = base + analyticsRetentionMs;
  await archiveAnalytics(bindings, now);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_sessions").first("n")).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_session_visits").first("n")).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_participants").first("n")).toBe(1);
  expect((await report()).summary).toEqual(before);
  now += 1000;
  await archiveAnalytics(bindings, now);
  await archiveAnalytics(bindings, now);
  expect((await report()).summary).toEqual(before);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_participants").first("n")).toBe(0);
  const columns = await db
    .prepare("PRAGMA table_info(analytics_acquisition_daily)")
    .all<{ name: string }>();
  expect(columns.results.map((row) => row.name)).toEqual([
    "day",
    "game",
    "internal",
    "dimension",
    "value",
    "medium",
    "campaign",
    "visits",
    "started",
  ]);
});

test("本人・テストの除外を訪問と開始の両方へ適用し、混在対局の一般参加者を残す", async () => {
  const owner = await account(),
    tester = await account();
  await db.prepare("UPDATE user SET isTestUser=1 WHERE id=?").bind(tester.id).run();
  const visitor = crypto.randomUUID(),
    ownerVisitor = crypto.randomUUID(),
    testVisitor = crypto.randomUUID();
  await view(visitor);
  await view(ownerVisitor, landing, { cookie: owner.cookie });
  await view(testVisitor, landing, { cookie: tester.cookie });
  const record = match([visitor, ownerVisitor, testVisitor]);
  record.participants[1]!.accountId = owner.id;
  record.participants[2]!.accountId = tester.id;
  record.participants[2]!.isTest = true;
  await writeAnalyticsMatch(db, record);
  const config = { ...bindings, ADMIN_ACCOUNT_ID: owner.id };
  for (const archived of [false, true]) {
    if (archived) {
      now += analyticsRetentionMs;
      await archiveAnalytics(config, now);
    }
    expect(
      (await readAcquisition(config, query, now)).summary.find((row) => row.dimension === "device"),
    ).toMatchObject({ visits: 1, started: 1 });
    expect(
      (await readAcquisition(config, { ...query, includeInternal: "true" }, now)).summary.find(
        (row) => row.dimension === "device",
      ),
    ).toMatchObject({ visits: 3, started: 1 });
  }
});

test("ゲストから登録した本人の退会受付で関連訪問を削除し、遅延保存で復活させない", async () => {
  const registered = await account(),
    visitor = crypto.randomUUID();
  await view(visitor);
  now += 1000;
  await view(visitor, landing, { cookie: registered.cookie });
  const record = match([visitor]);
  record.participants[0]!.accountId = registered.id;
  await writeAnalyticsMatch(db, record);
  await db
    .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES (?,?,?)")
    .bind(registered.id, now, crypto.randomUUID())
    .run();
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_sessions").first("n")).toBe(0);
  expect((await report()).summary).toEqual([]);
  await writeAnalyticsMatch(db, { ...record, id: crypto.randomUUID() });
  expect((await report()).summary).toEqual([]);
});

test("訪問保存の失敗は閲覧と訪問を同時にロールバックし、同じIDで再試行できる", async () => {
  const visitor = crypto.randomUUID(),
    id = crypto.randomUUID();
  await db.exec(
    "CREATE TRIGGER fail_acquisition BEFORE INSERT ON analytics_sessions BEGIN SELECT RAISE(ABORT,'test fault'); END",
  );
  try {
    expect(
      (
        await post("pageviews", visitor, {
          id,
          page: "general-lobby",
          game: null,
          acquisition: landing,
        })
      ).status,
    ).toBe(503);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_pageviews").first("n")).toBe(0);
  } finally {
    await db.exec("DROP TRIGGER fail_acquisition");
  }
  await view(visitor, landing, { id });
  expect((await report()).summary.find((row) => row.dimension === "device")?.visits).toBe(1);
});

test("匿名集約の途中失敗では元データと全区分を残し、再実行で重複計上しない", async () => {
  const visitor = crypto.randomUUID();
  await view(visitor);
  await writeAnalyticsMatch(db, match([visitor]));
  const before = (await report()).summary;
  now += analyticsRetentionMs;
  await db.exec(
    "CREATE TRIGGER fail_archive BEFORE INSERT ON analytics_acquisition_daily WHEN NEW.dimension='utm' BEGIN SELECT RAISE(ABORT,'test archive fault'); END",
  );
  try {
    await expect(archiveAnalytics(bindings, now)).rejects.toThrow("test archive fault");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_sessions").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_participants").first("n")).toBe(1);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM analytics_acquisition_daily").first("n"),
    ).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_daily").first("n")).toBe(0);
    expect((await report()).summary).toEqual([]);
  } finally {
    await db.exec("DROP TRIGGER fail_archive");
  }
  await archiveAnalytics(bindings, now);
  await archiveAnalytics(bindings, now);
  expect((await report()).summary).toEqual(before);
});

test("日本時間の日跨ぎと月別・期間絞り込みを扱い、計測開始前の対局を補完しない", async () => {
  now = Date.parse("2004-01-01T23:59:50+09:00");
  const visitor = crypto.randomUUID();
  await view(visitor, landing, { game: "four-shogi" });
  now += 20000;
  await view(visitor, landing, { game: "reversi" });
  await writeAnalyticsMatch(db, match([visitor]));
  const rows = await report();
  expect(rows.buckets[0]!.rows.find((row) => row.dimension === "device")).toMatchObject({
    visits: 1,
    started: 0,
  });
  expect(rows.buckets[1]!.rows.find((row) => row.dimension === "device")).toMatchObject({
    visits: 0,
    started: 1,
  });
  const filtered = await readAcquisition(bindings, { ...query, game: "reversi" }, now);
  expect(filtered.buckets[0]!.rows).toEqual([]);
  expect(filtered.buckets[1]!.rows.find((row) => row.dimension === "device")).toMatchObject({
    visits: 1,
    started: 0,
  });
  expect((await readAcquisition(bindings, { ...query, bucket: "month" }, now)).summary).toEqual(
    rows.summary,
  );
  expect(
    (await readAcquisition(bindings, { ...query, from: "2003-01-01", to: "2003-01-31" }, now))
      .summary,
  ).toEqual([]);
  await writeAnalyticsMatch(db, match([visitor], base - 7200000));
  expect((await report()).summary).toEqual(rows.summary);
});

test("計測Cookieのない人間の開始も不明区分に残し、存在しない訪問を作らない", async () => {
  const record = match([crypto.randomUUID()]);
  record.participants[0]!.visitorId = null;
  await writeAnalyticsMatch(db, record);
  expect((await report()).summary).toEqual([
    { dimension: "device", value: "", medium: "", campaign: "", visits: 0, started: 1 },
    { dimension: "referrer", value: "", medium: "", campaign: "", visits: 0, started: 1 },
    { dimension: "utm", value: "", medium: "", campaign: "", visits: 0, started: 1 },
  ]);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM analytics_sessions").first("n")).toBe(0);
});
