import { expect, test } from "vitest";
import { kpiQuerySchema } from "@tetraboard/protocol";
import {
  calculateEventKpi,
  ratio,
  replayWithin7Days,
  waitingPercentiles,
} from "../src/kpi/calculations";
import { dayMs, japanDayStart, kpiPeriod, previousJapanMonth } from "../src/kpi/period";
import { eventRow, eventRows, visit } from "./kpiFixtures";

test("期間は日本時間の両端を含み、実在する日付と最大92日を検証する", () => {
  expect(kpiPeriod({ from: "2024-02-29", to: "2024-03-01" })).toEqual({
    fromMs: Date.parse("2024-02-28T15:00:00Z"),
    toMs: Date.parse("2024-03-01T15:00:00Z"),
    from: "2024-02-28T15:00:00.000Z",
    to: "2024-03-01T15:00:00.000Z",
  });
  expect(kpiQuerySchema.safeParse({ from: "2026-01-01", to: "2026-04-02" }).success).toBe(true);
  for (const input of [
    { from: "2026-01-01", to: "2026-04-03" },
    { from: "2026-02-29", to: "2026-03-01" },
    { from: "2026-03-01", to: "2026-02-28" },
    { from: "2026-11-1", to: "2026-11-02" },
  ])
    expect(kpiQuerySchema.safeParse(input).success).toBe(false);
  expect(previousJapanMonth(Date.parse("2026-12-31T14:59:59Z"))).toEqual({
    month: "2026-11",
    from: "2026-11-01",
    to: "2026-11-30",
  });
  expect(previousJapanMonth(Date.parse("2026-12-31T15:00:00Z"))).toEqual({
    month: "2026-12",
    from: "2026-12-01",
    to: "2026-12-31",
  });
  expect(japanDayStart(Date.parse("2026-11-01T14:59:59Z"))).toBe(
    Date.parse("2026-10-31T15:00:00Z"),
  );
});

test("割合の分母0はnull、中央値は偶数の中央2値の平均、p90はnearest rankで数える", () => {
  expect(ratio(0, 0)).toEqual({ numerator: 0, denominator: 0, rate: null });
  expect(ratio(1, 4).rate).toBe(0.25);
  expect(waitingPercentiles([])).toEqual({ median: null, p90: null });
  expect(
    waitingPercentiles([
      { value: 100, count: 1 },
      { value: 10, count: 9 },
    ]),
  ).toEqual({ median: 10, p90: 10 });
  expect(
    waitingPercentiles([
      { value: 10, count: 1 },
      { value: 20, count: 1 },
    ]),
  ).toEqual({ median: 15, p90: 20 });
  expect(
    waitingPercentiles([
      { value: 1, count: 1000000 },
      { value: 1000, count: 1 },
    ]),
  ).toEqual({ median: 1, p90: 1 });
});

test("後からテストと判明したブラウザ・アカウントとテスト対局を除き、IDを重複排除する", () => {
  const rows = [
    visit("browser"),
    visit("browser"),
    visit("other"),
    visit("test-browser"),
    visit("alias", "test-account"),
    eventRow({
      name: "client_error",
      isTest: true,
      browserId: "test-browser",
      accountId: "test-account",
      page: "lobby",
      kind: "error",
      message: "test",
    }),
    eventRow({
      name: "match_started",
      isTest: false,
      matchId: "human",
      mode: "singles",
      matchKind: "normal",
      humans: 2,
      cpus: 0,
    }),
    eventRow({
      name: "match_started",
      isTest: false,
      matchId: "cpu",
      mode: "singles",
      matchKind: "normal",
      humans: 1,
      cpus: 1,
    }),
    eventRow({
      name: "match_started",
      isTest: true,
      matchId: "test",
      mode: "singles",
      matchKind: "normal",
      humans: 2,
      cpus: 0,
    }),
    eventRow({
      name: "match_participant",
      isTest: false,
      browserId: "browser",
      matchId: "human",
      isGuest: true,
    }),
    eventRow({
      name: "match_participant",
      isTest: false,
      browserId: "other",
      matchId: "test",
      isGuest: true,
    }),
    ...["human", "human", "test", "outside"].map((matchId) =>
      eventRow({
        name: "match_ended",
        isTest: false,
        matchId,
        result: "completed",
        reason: "done",
        durationMs: 1,
      }),
    ),
    ...["flow", "flow", ""].map((flowId) =>
      eventRow({
        name: "registration",
        isTest: false,
        browserId: "browser",
        flowId,
        stage: "entry",
        entry: "login-page",
      }),
    ),
    eventRow({
      name: "registration",
      isTest: false,
      accountId: "test-account",
      flowId: "excluded",
      stage: "entry",
      entry: "login-page",
    }),
    eventRow(
      {
        name: "matchmaking",
        isTest: false,
        operationId: "op",
        stage: "matched",
        reason: null,
        rated: true,
        waitingMs: 100,
      },
      9,
    ),
    eventRow({
      name: "matchmaking",
      isTest: false,
      operationId: "op2",
      stage: "matched",
      reason: null,
      rated: true,
      waitingMs: 1000,
    }),
    eventRow({
      name: "matchmaking",
      isTest: true,
      operationId: "test",
      stage: "matched",
      reason: null,
      rated: true,
      waitingMs: 999999,
    }),
  ];
  const before = structuredClone(rows);
  const result = calculateEventKpi(eventRows(rows));
  expect(result.visitingBrowsers).toBe(2);
  expect(result.matchStartRate).toEqual(ratio(1, 2));
  expect(result.matchCompletionRate).toEqual(ratio(1, 2));
  expect(result.humanMatchRate).toEqual(ratio(1, 2));
  expect(result.acquisition).toEqual([
    {
      referrerClass: "search",
      utmSource: "source",
      utmMedium: "",
      utmCampaign: "",
      device: "pc",
      visitingBrowsers: 2,
      participatingBrowsers: 1,
    },
  ]);
  expect(result.registration).toEqual([{ entry: "login-page", stage: "entry", flows: 1 }]);
  expect(result.matchmaking).toEqual([
    { stage: "matched", count: 10, waitingMs: { median: 100, p90: 100 } },
  ]);
  expect(rows).toEqual(before);
  expect(calculateEventKpi(eventRows([])).matchCompletionRate).toEqual(ratio(0, 0));
});

test("新規登録はregisteredのアカウントIDを数え、重複・IDなし・他段階・テスト本人を除く", () => {
  const registration = (
    accountId: string,
    browserId: string,
    flowId?: string,
    stage:
      | "registered"
      | "entry"
      | "oauth_success"
      | "existing_login"
      | "profile_complete" = "registered",
    isTest = false,
  ) =>
    eventRow({
      name: "registration",
      isTest,
      accountId,
      browserId,
      flowId,
      stage,
      entry: "login-page",
    });
  const rows = [
    registration("account", "browser", "first"),
    registration("account", "other-browser", "second"),
    registration("account-without-flow", "browser"),
    registration("", "browser", "no-account"),
    ...(["entry", "oauth_success", "existing_login", "profile_complete"] as const).map((stage) =>
      registration(stage, "browser", stage, stage),
    ),
    registration("test-account", "other-browser", "test-account"),
    registration("other-account", "test-browser", "test-browser"),
    registration("explicit-test", "explicit-test-browser", "test", "registered", true),
    eventRow({
      name: "client_error",
      isTest: true,
      accountId: "test-account",
      browserId: "test-browser",
      page: "lobby",
      kind: "error",
      message: "test",
    }),
  ];
  expect(calculateEventKpi(eventRows(rows)).newRegistrations).toBe(2);
  expect(calculateEventKpi(eventRows([])).newRegistrations).toBe(0);
});

test("再対局は翌日から7日目までを含み、初回が期間外・同日だけ・観測中を区別する", () => {
  const period = kpiPeriod({ from: "2026-11-01", to: "2026-11-30" });
  const first = Date.parse("2026-11-01T23:59:59+09:00");
  const nextDay = japanDayStart(first) + dayMs;
  const end = nextDay + 7 * dayMs;
  const rows = [
    { accountId: "returned", matchId: "first", endedAtMs: first },
    { accountId: "returned", matchId: "second", endedAtMs: end - 1 },
    { accountId: "same-day", matchId: "first", endedAtMs: first - 1000 },
    { accountId: "same-day", matchId: "second", endedAtMs: nextDay - 1 },
    { accountId: "late", matchId: "first", endedAtMs: first },
    { accountId: "late", matchId: "second", endedAtMs: end },
    { accountId: "old", matchId: "first", endedAtMs: period.fromMs - 1 },
    { accountId: "old", matchId: "second", endedAtMs: first },
    { accountId: "observing", matchId: "first", endedAtMs: end - 1 },
    { accountId: "observing", matchId: "second", endedAtMs: end },
  ];
  expect(replayWithin7Days(rows, period, end)).toEqual({ ...ratio(1, 3), observing: 1 });
  expect(replayWithin7Days(rows.slice(0, 2), period, end - 1)).toEqual({
    ...ratio(0, 0),
    observing: 1,
  });
  expect(
    replayWithin7Days(
      [
        { accountId: "a", matchId: "f", endedAtMs: first },
        { accountId: "a", matchId: "s", endedAtMs: nextDay },
      ],
      period,
      end,
    ),
  ).toEqual({ ...ratio(1, 1), observing: 0 });
});
