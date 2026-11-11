import { env } from "cloudflare:workers";
import { test, expect } from "vitest";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { runAnalyticsAggregation } from "../src/analytics/foundation";
const context = { waitUntil() {} } as unknown as ExecutionContext;
test("集客APIは5分スナップショットだけを返し、リンク・実参照元・未集計と0件を区別する", async () => {
  const owner = await accountFixture();
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  const path =
    "/api/admin/analytics/acquisition?from=2026-11-11&to=2026-11-11&includeInternal=true";
  const get = () =>
    worker.fetch(
      new AcceptedGameRequest(origin + path, { headers: { Cookie: owner.cookie } }),
      bindings,
      context,
    );
  expect((await get()).status).toBe(200);
  const id = crypto.randomUUID(),
    at = Date.now() + 10;
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT INTO analytics_sessions(id,visitor_id,started_at_ms,last_activity_ms,referrer_host,referrer_class,utm_source,utm_medium,utm_campaign,device,utm_link_id) VALUES(?,?,?,?,'t.co','social','link-1','social','profile','mobile',1)",
    ).bind(id, id, at, at),
    env.APP_DB.prepare("INSERT INTO analytics_session_visits VALUES(?,'*',?,NULL,0)").bind(id, at),
  ]);
  const before = (await (await get()).json()) as any;
  expect(before.rows.some((r: any) => r.dimension === "host" && r.value === "t.co")).toBe(false);
  await runAnalyticsAggregation(bindings, at + 1000);
  const after = (await (await get()).json()) as any;
  expect(after.rows.find((r: any) => r.dimension === "link" && r.value === "1")).toMatchObject({
    visits: 1,
    label: "開発者Xプロフィール",
  });
  expect(after.rows.find((r: any) => r.dimension === "host" && r.value === "t.co")).toMatchObject({
    visits: 1,
    started: null,
  });
  const sql: string[] = [];
  const db = new Proxy(env.APP_DB, {
    get(t, k) {
      if (k === "prepare")
        return (s: string) => {
          sql.push(s);
          return t.prepare(s);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const response = await worker.fetch(
    new AcceptedGameRequest(origin + path, { headers: { Cookie: owner.cookie } }),
    { ...bindings, APP_DB: db },
    context,
  );
  expect(response.status).toBe(200);
  expect(
    sql.some((s) =>
      /FROM analytics_sessions|JOIN analytics_participants|sqlite_master|pragma_table_info|DELETE FROM|INSERT INTO/i.test(
        s,
      ),
    ),
  ).toBe(false);
});

test("集客の再集計失敗は公開値と時刻を保持し、再実行と90日削除でも二重加算しない", async () => {
  const { aggregateAcquisition, readAcquisitionSnapshot } =
    await import("../src/analytics/acquisitionAggregation");
  const { archiveAnalytics } = await import("../src/analytics/retention");
  const { analyticsRetentionMs } = await import("@tetraboard/protocol/privacy");
  const now = Date.now() + 100,
    day = new Date(now + 32400000).toISOString().slice(0, 10),
    host = `h-${crypto.randomUUID()}.example`;
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: "[]" };
  async function visit() {
    const id = crypto.randomUUID();
    await env.APP_DB.batch([
      env.APP_DB.prepare(
        "INSERT INTO analytics_sessions(id,visitor_id,started_at_ms,last_activity_ms,referrer_host,referrer_class,utm_link_id,utm_source,utm_medium,utm_campaign) VALUES(?,?,?, ?,?,'other',4,'link-4','social','post')",
      ).bind(id, id, now, now, host),
      env.APP_DB.prepare("INSERT INTO analytics_session_visits VALUES(?,'*',?,NULL,0)").bind(
        id,
        now,
      ),
    ]);
  }
  const q = { from: day, to: day, game: "all", bucket: "day", includeInternal: "true" } as const;
  await visit();
  await aggregateAcquisition(bindings, now + 1);
  const before = await readAcquisitionSnapshot(bindings, q, now + 1);
  expect(before.rows.find((r) => r.dimension === "host" && r.value === host)?.visits).toBe(1);
  await visit();
  await env.APP_DB.exec(
    "CREATE TRIGGER insights_test_fail BEFORE INSERT ON analytics_acquisition_snapshot WHEN NEW.dimension='host' BEGIN SELECT RAISE(ABORT,'test snapshot failure'); END;",
  );
  try {
    await expect(aggregateAcquisition(bindings, now + 2)).rejects.toThrow();
    const failed = await readAcquisitionSnapshot(bindings, q, now + 2);
    expect(failed.aggregatedAtMs).toBe(before.aggregatedAtMs);
    expect(failed.rows.find((r) => r.dimension === "host" && r.value === host)?.visits).toBe(1);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER insights_test_fail");
  }
  await aggregateAcquisition(bindings, now + 3);
  await aggregateAcquisition(bindings, now + 4);
  expect(
    (await readAcquisitionSnapshot(bindings, q, now + 4)).rows.find(
      (r) => r.dimension === "host" && r.value === host,
    )?.visits,
  ).toBe(2);
  await archiveAnalytics(bindings, now + analyticsRetentionMs + 1);
  await aggregateAcquisition(bindings, now + analyticsRetentionMs + 2);
  const old = await readAcquisitionSnapshot(bindings, q, now + analyticsRetentionMs + 2);
  expect(old.hostAvailable).toBe(false);
  expect(old.rows.some((r) => r.dimension === "host")).toBe(false);
  expect(old.rows.find((r) => r.dimension === "link" && r.value === "4")?.visits).toBe(2);
  await archiveAnalytics(bindings, now + analyticsRetentionMs + 3);
  await aggregateAcquisition(bindings, now + analyticsRetentionMs + 4);
  expect(
    (await readAcquisitionSnapshot(bindings, q, now + analyticsRetentionMs + 4)).rows.find(
      (r) => r.dimension === "link" && r.value === "4",
    )?.visits,
  ).toBe(2);
});
