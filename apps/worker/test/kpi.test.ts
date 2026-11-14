import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { kpiReportSchema } from "@tetraboard/protocol";
import worker from "../src/worker";
import * as queries from "../src/kpi/query";
import { readKpi } from "../src/kpi/report";
import { savePreviousMonthKpi } from "../src/kpi/monthly";
import { readBusinessKpi } from "../src/kpi/business";
import { accountFixture, origin } from "./accountFixtures";
import { eventRow, fixedUsageQuery, visit } from "./kpiFixtures";
import { kpiPeriod } from "../src/kpi/period";
import type { UsageEvent } from "../src/usageEvents/events";

// 毎時保守の専用DBを使い、共有APP_DBの退会待ちfixtureを巡回しません。
const db = (bindings as typeof bindings & { SCHEDULED_MAINTENANCE_TEST_DB: D1Database })
  .SCHEDULED_MAINTENANCE_TEST_DB;
const env = {
  ...bindings,
  APP_DB: db,
  USAGE_EVENTS_DATASET: "tetraboard_usage_events_local" as const,
};
const period = { from: "1981-01-01", to: "1981-01-31" };
const at = (day: string) => Date.parse(`${day}T12:00:00+09:00`);
const now = at("1981-02-10");
const accounts: string[] = [];
const matches: string[] = [];

beforeAll(async () => {
  await applyD1Migrations(
    db,
    (bindings as typeof bindings & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.exec("DROP TRIGGER IF EXISTS fail_kpi_monthly");
  for (const id of matches.splice(0)) {
    await db.prepare("DELETE FROM account_match_history WHERE match_id=?").bind(id).run();
    await db.prepare("DELETE FROM matches WHERE id=?").bind(id).run();
  }
  for (const id of accounts.splice(0)) {
    await db.prepare("DELETE FROM session WHERE userId=?").bind(id).run();
    await db.prepare("DELETE FROM deleted_accounts WHERE id=?").bind(id).run();
    await db.prepare("DELETE FROM user WHERE id=?").bind(id).run();
  }
  await db.prepare("DELETE FROM kpi_monthly WHERE month IN ('1981-01','1980-12')").run();
});

async function account(
  options: {
    test?: boolean;
    guest?: boolean;
    createdAt?: number | string;
    deleted?: boolean;
  } = {},
) {
  const value = await accountFixture(true, crypto.randomUUID(), db);
  accounts.push(value.id);
  await db
    .prepare("UPDATE user SET createdAt=?,isTestUser=?,isAnonymous=? WHERE id=?")
    .bind(
      options.createdAt ?? at("1981-01-02"),
      Number(options.test ?? false),
      Number(options.guest ?? false),
      value.id,
    )
    .run();
  if (options.deleted)
    await db
      .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)")
      .bind(value.id, now, value.id)
      .run();
  return value;
}

async function completed(endedAt: number, ids: string[]) {
  const id = crypto.randomUUID();
  matches.push(id);
  await db
    .prepare(
      "INSERT INTO matches(id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES(?,'four-reversi','singles',?,?,?)",
    )
    .bind(id, endedAt - 10000, endedAt, JSON.stringify({ participants: [] }))
    .run();
  for (const accountId of ids)
    await db
      .prepare(
        "INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms) VALUES(?,?,'singles',?)",
      )
      .bind(accountId, id, endedAt - 10000)
      .run();
  return id;
}

function fakeEvents(registeredAccountId = "registered-account") {
  return fixedUsageQuery([
    visit("visitor"),
    visit("visitor"),
    visit("other"),
    eventRow({
      name: "match_participant",
      isTest: false,
      browserId: "visitor",
      matchId: "match",
      isGuest: true,
    }),
    eventRow({
      name: "match_started",
      isTest: false,
      matchId: "match",
      mode: "singles",
      matchKind: "normal",
      humans: 2,
      cpus: 0,
    }),
    eventRow({
      name: "match_ended",
      isTest: false,
      matchId: "match",
      result: "completed",
      reason: "done",
      durationMs: 10,
    }),
    eventRow({
      name: "registration",
      isTest: false,
      flowId: "flow",
      stage: "entry",
      entry: "login-page",
    }),
    ...["visitor", "other"].map((browserId) =>
      eventRow({
        name: "registration",
        isTest: false,
        browserId,
        accountId: registeredAccountId,
        flowId: "flow",
        stage: "registered",
        entry: "login-page",
      }),
    ),
    eventRow({
      name: "matchmaking",
      isTest: false,
      operationId: "operation",
      stage: "matched",
      reason: null,
      rated: true,
      waitingMs: 1000,
    }),
  ]);
}

test("/apiあり・なしの管理APIは管理者だけが読め、実D1と偽物のイベントをスキーマどおり返す", async () => {
  const owner = await account({ createdAt: at("1980-12-01") });
  const other = await account();
  await completed(at("1981-01-02"), [other.id]);
  const factory = vi.spyOn(queries, "createUsageEventQuery").mockReturnValue(fakeEvents());
  const configured = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  const fetchApi = (path: string, cookie?: string) =>
    worker.fetch(
      new Request(origin + path, { headers: cookie ? { Cookie: cookie } : {} }),
      configured,
      {} as ExecutionContext,
    );
  for (const prefix of ["", "/api"]) {
    const path = `${prefix}/admin/kpi?from=${period.from}&to=${period.to}`;
    for (const [cookie, status] of [
      [undefined, 401],
      [other.cookie, 403],
    ] as const) {
      const response = await fetchApi(path, cookie);
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const response = await fetchApi(path, owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = kpiReportSchema.parse(await response.json());
    expect(result.completedMatches).toBe(1);
    expect(result.players).toBe(1);
    expect(result.newRegistrations).toBe(1);
    expect(result.replayWithin7Days).toEqual({
      numerator: 0,
      denominator: 1,
      rate: 0,
      observing: 0,
    });
    expect(result.events?.visitingBrowsers).toBe(2);
    expect(result.events?.matchStartRate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(result.events?.matchCompletionRate.rate).toBe(1);
    expect(result.events?.registration).toEqual([
      { entry: "login-page", stage: "entry", flows: 1 },
      { entry: "login-page", stage: "registered", flows: 1 },
    ]);
    expect(result.events?.matchmaking[0]?.waitingMs).toEqual({ median: 1000, p90: 1000 });
    expect(result.sampling).toBe("unknown");
  }
  expect(factory).toHaveBeenCalledTimes(2);
  for (const query of ["", "?from=1981-01-01&to=1981-04-04", "?from=1981-02-29&to=1981-03-01"])
    expect((await fetchApi(`/api/admin/kpi${query}`, owner.cookie)).status).toBe(400);
});

test("D1は完了日の日本時間境界・テストだけの局・混合局・ゲスト・退会を区別する", async () => {
  const normal = await account();
  const testUser = await account({ test: true });
  const guest = await account({ guest: true });
  const deleted = await account();
  const end = Date.parse("1981-01-31T15:00:00Z");
  await completed(Date.parse("1980-12-31T14:59:59Z"), [normal.id]);
  await completed(Date.parse("1980-12-31T15:00:00Z"), [normal.id, testUser.id]);
  await completed(end - 1, [guest.id]);
  await completed(end, [normal.id]);
  await completed(at("1981-01-03"), [testUser.id]);
  await completed(at("1981-01-04"), [deleted.id]);
  await db
    .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)")
    .bind(deleted.id, now, deleted.id)
    .run();
  const result = await readBusinessKpi(env, period, now);
  expect(result.completedMatches).toBe(3);
  expect(result.players).toBe(2);
  expect(result.replayWithin7Days.denominator).toBe(1);
});

test("初回の再対局の観測は期間外の履歴と翌月を含み、観測中は分母から除く", async () => {
  const returned = await account(),
    sameDay = await account(),
    old = await account(),
    observing = await account();
  await completed(at("1981-01-01"), [returned.id, sameDay.id]);
  await completed(at("1981-01-01") + 1000, [sameDay.id]);
  await completed(Date.parse("1981-01-07T14:59:59Z"), [returned.id]);
  await completed(at("1980-12-31"), [old.id]);
  await completed(at("1981-01-02"), [old.id]);
  await completed(at("1981-01-31"), [observing.id]);
  await completed(at("1981-02-01"), [observing.id]);
  const report = await readBusinessKpi(env, period, at("1981-02-03"));
  expect(report.replayWithin7Days).toEqual({
    numerator: 1,
    denominator: 2,
    rate: 0.5,
    observing: 1,
  });
  expect((await readBusinessKpi(env, period, now)).replayWithin7Days).toEqual({
    numerator: 2,
    denominator: 3,
    rate: 2 / 3,
    observing: 0,
  });
});

test("新規登録はD1の登録数を使わず、後で退会したアカウントもイベントから数える", async () => {
  await account();
  await account();
  const deleted = await account({ deleted: true });
  await db.prepare("DELETE FROM user WHERE id=?").bind(deleted.id).run();
  const result = await readKpi(env, period, now, fakeEvents(deleted.id));
  expect(result.newRegistrations).toBe(1);
  expect(result.eventsUnavailableReason).toBeNull();
  expect(result).not.toHaveProperty("newRegistrationsUnavailableReason");
  expect((await readKpi(env, period, now, fixedUsageQuery([]))).newRegistrations).toBe(0);
});

test("時刻つきの登録イベントを対応づけ、10分前の開始と期間外の完了を件数へ混ぜない", async () => {
  const { fromMs, toMs } = kpiPeriod(period);
  type Registration = Extract<UsageEvent, { name: "registration" }>;
  const row = (
    stage: Registration["stage"],
    atMs: number,
    details: Partial<Registration> = {},
  ) => ({
    ...eventRow({
      name: "registration",
      stage,
      entry: "unknown",
      isTest: false,
      browserId: "browser",
      accountId: "account",
      ...details,
    }),
    timestamp: new Date(atMs).toISOString(),
  });
  const result = await readKpi(
    env,
    period,
    now,
    fixedUsageQuery([
      row("oauth_start", fromMs - 600000, { flowId: "flow", entry: "login-page" }),
      row("oauth_success", fromMs - 1000, { accountId: "before" }),
      row("registered", fromMs - 999, { accountId: "before" }),
      row("oauth_success", fromMs),
      row("registered", fromMs),
      row("profile_complete", fromMs + 700000, { browserId: "different" }),
      row("oauth_success", fromMs + 700000, { accountId: "unmatched", browserId: "other" }),
      row("existing_login", fromMs + 700001, { accountId: "unmatched", browserId: "other" }),
      row("registered", toMs, { accountId: "after" }),
    ]),
  );
  expect(result.eventsUnavailableReason).toBeNull();
  expect(result.newRegistrations).toBe(1);
  expect(result.events?.registration).toEqual([
    { entry: "login-page", stage: "oauth_success", flows: 1 },
    { entry: "login-page", stage: "registered", flows: 1 },
    { entry: "login-page", stage: "profile_complete", flows: 1 },
    { entry: "unknown", stage: "oauth_success", flows: 1 },
    { entry: "unknown", stage: "existing_login", flows: 1 },
  ]);
});

test("イベントの問い合わせ失敗でもD1の値を返し、エラー本文の秘密を返さない", async () => {
  const owner = await account();
  await completed(at("1981-01-01"), [owner.id]);
  vi.spyOn(queries, "createUsageEventQuery").mockReturnValue({
    async rows() {
      throw new Error("secret-account-id");
    },
  });
  const configured = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  const response = await worker.fetch(
    new Request(`${origin}/api/admin/kpi?from=${period.from}&to=${period.to}`, {
      headers: { Cookie: owner.cookie },
    }),
    configured,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const report = kpiReportSchema.parse(JSON.parse(body));
  expect(report.completedMatches).toBe(1);
  expect(report.players).toBe(1);
  expect(report.newRegistrations).toBeNull();
  expect(report.events).toBeNull();
  expect(report.eventsUnavailableReason).toBeTruthy();
  expect(body).not.toContain("secret-account-id");
  expect(JSON.parse(body)).not.toHaveProperty("newRegistrationsUnavailableReason");
});

test("月次は日本時間の前月を一度だけ保存し、IDと表を保存しない", async () => {
  const factory = vi.spyOn(queries, "createUsageEventQuery").mockReturnValue(fakeEvents());
  await account();
  await savePreviousMonthKpi(env, now);
  const first = await db
    .prepare("SELECT * FROM kpi_monthly WHERE month='1981-01' ORDER BY metric")
    .all();
  expect(first.results.length).toBeGreaterThan(10);
  expect(first.results).toContainEqual({
    month: "1981-01",
    metric: "visitingBrowsers",
    value: 2,
    computed_at_ms: now,
  });
  expect(first.results).toContainEqual({
    month: "1981-01",
    metric: "newRegistrations",
    value: 1,
    computed_at_ms: now,
  });
  expect(JSON.stringify(first.results)).not.toMatch(
    /visitor|matchmaking|acquisition|registration.*entry/,
  );
  await savePreviousMonthKpi(env, now + 3600000);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(
    (await db.prepare("SELECT * FROM kpi_monthly WHERE month='1981-01' ORDER BY metric").all())
      .results,
  ).toEqual(first.results);
});

test("月次の問い合わせ失敗・保存途中の失敗では1行も残らず、次回に再試行できる", async () => {
  const factory = vi.spyOn(queries, "createUsageEventQuery").mockReturnValue({
    async rows() {
      throw new Error("failed");
    },
  });
  await expect(savePreviousMonthKpi(env, now)).rejects.toThrow("incomplete");
  expect(
    (await db.prepare("SELECT * FROM kpi_monthly WHERE month='1981-01'").all()).results,
  ).toEqual([]);
  factory.mockReturnValue(fakeEvents());
  await db.exec(
    "CREATE TRIGGER fail_kpi_monthly BEFORE INSERT ON kpi_monthly WHEN NEW.metric='players' BEGIN SELECT RAISE(ABORT,'failed'); END",
  );
  await expect(savePreviousMonthKpi(env, now)).rejects.toThrow();
  expect(
    (await db.prepare("SELECT * FROM kpi_monthly WHERE month='1981-01'").all()).results,
  ).toEqual([]);
  await db.exec("DROP TRIGGER fail_kpi_monthly");
  await savePreviousMonthKpi(env, now);
  expect(
    (await db.prepare("SELECT * FROM kpi_monthly WHERE month='1981-01'").all()).results.length,
  ).toBeGreaterThan(0);
});

test("退会済みでも登録イベントから月次の新規登録数を保存する", async () => {
  const deleted = await account({ deleted: true });
  await db.prepare("DELETE FROM user WHERE id=?").bind(deleted.id).run();
  vi.spyOn(queries, "createUsageEventQuery").mockReturnValue(fakeEvents(deleted.id));
  const report = await readKpi(env, period, now);
  expect(report.newRegistrations).toBe(1);
  await savePreviousMonthKpi(env, now);
  expect(
    await db
      .prepare("SELECT value FROM kpi_monthly WHERE month='1981-01' AND metric='newRegistrations'")
      .first("value"),
  ).toBe(1);
});
