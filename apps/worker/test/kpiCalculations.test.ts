import { expect, test } from "vitest";
import { kpiQuerySchema } from "@tetraboard/protocol";
import {
  calculateEventKpi,
  attributeRegistrationEvents,
  ratio,
  replayWithin7Days,
  waitingPercentiles,
} from "../src/kpi/calculations";
import { dayMs, japanDayStart, kpiPeriod, previousJapanMonth } from "../src/kpi/period";
import { eventRow, eventRows, visit } from "./kpiFixtures";
import type { UsageEvent } from "../src/usageEvents/events";

const eventPeriod = kpiPeriod({ from: "1981-01-01", to: "1981-01-31" });
type RegistrationEvent = Extract<UsageEvent, { name: "registration" }>;
function registrationAt(
  stage: RegistrationEvent["stage"],
  offsetMs: number,
  details: Partial<RegistrationEvent> = {},
) {
  return {
    ...eventRow({
      name: "registration",
      isTest: false,
      browserId: "browser",
      accountId: "account",
      entry: "unknown",
      stage,
      ...details,
    }),
    timestamp: new Date(eventPeriod.fromMs + offsetMs).toISOString(),
  };
}

test.each([
  { elapsed: 600000, browserId: "browser", expected: "flow" },
  { elapsed: 600001, browserId: "browser", expected: null },
  { elapsed: 1, browserId: "other", expected: null },
  { elapsed: 1, browserId: "", expected: null },
  { elapsed: 0, browserId: "browser", expected: null },
])(
  "OAuth完了の対応づけは直前10分以内の同じブラウザだけを使う: %j",
  ({ elapsed, browserId, expected }) => {
    const rows = [
      registrationAt("oauth_start", 0, { flowId: "flow", entry: "login-page" }),
      ...(["oauth_success", "registered", "existing_login"] as const).map((stage) =>
        registrationAt(stage, elapsed, { browserId }),
      ),
    ];
    const result = attributeRegistrationEvents(rows);
    for (const row of result.filter((r) => r.blob7 !== "oauth_start")) {
      expect(row.blob8).toBe(expected ? "login-page" : "unknown");
      if (expected) expect(row.blob6).toBe(expected);
      else expect(row.blob6).toBeTruthy();
    }
  },
);

test("最新のOAuth開始を選び、未来・同時刻の開始を使わず、既存の手続きIDを保持する", () => {
  const rows = [
    registrationAt("oauth_start", -2000, { flowId: "old", entry: "room-result" }),
    registrationAt("oauth_start", -1000, { flowId: "latest", entry: "login-page" }),
    registrationAt("oauth_start", 0, { flowId: "same-time", entry: "room-result" }),
    registrationAt("oauth_start", 1, { flowId: "future", entry: "room-result" }),
    registrationAt("oauth_success", 0),
    registrationAt("registered", 0, { flowId: "original", entry: "account-link" }),
  ].reverse();
  const before = structuredClone(rows);
  const result = attributeRegistrationEvents(rows);
  expect(result.find((r) => r.blob7 === "oauth_success")).toMatchObject({
    blob6: "latest",
    blob8: "login-page",
  });
  expect(result.find((r) => r.blob7 === "registered")).toMatchObject({
    blob6: "original",
    blob8: "account-link",
  });
  expect(rows).toEqual(before);
});

test("プロフィール完了はブラウザが変わっても同じアカウントの直前のOAuth成功へ対応づく", () => {
  const rows = [
    registrationAt("oauth_start", -100, { flowId: "old", entry: "room-result" }),
    registrationAt("oauth_success", -99),
    registrationAt("oauth_start", -50, { flowId: "latest", entry: "login-page" }),
    registrationAt("oauth_success", -49),
    registrationAt("oauth_success", -1, {
      accountId: "other",
      flowId: "other",
      entry: "account-link",
    }),
    registrationAt("profile_complete", 0, { browserId: "new-browser" }),
    registrationAt("oauth_success", 0, { flowId: "same-time", entry: "room-result" }),
    registrationAt("profile_complete", 1, { accountId: "" }),
    registrationAt("profile_complete", 2, { accountId: "missing" }),
  ];
  const profiles = attributeRegistrationEvents(rows).filter((r) => r.blob7 === "profile_complete");
  expect(profiles[0]).toMatchObject({ blob6: "latest", blob8: "login-page" });
  expect(profiles.slice(1).every((r) => r.blob8 === "unknown" && r.blob6)).toBe(true);
});

test("対応先のない完了の2点はunknownの同じ手続きになり、別の完了と重複しない", () => {
  const rows = [
    registrationAt("oauth_success", 0),
    registrationAt("registered", 1),
    registrationAt("oauth_success", 2000),
    registrationAt("existing_login", 2001),
    registrationAt("profile_complete", 3000, { browserId: "other" }),
  ];
  const result = attributeRegistrationEvents(rows);
  expect(result.every((r) => r.blob8 === "unknown" && r.blob6)).toBe(true);
  expect(result[0]!.blob6).toBe(result[1]!.blob6);
  expect(result[2]!.blob6).toBe(result[3]!.blob6);
  expect(result[0]!.blob6).not.toBe(result[2]!.blob6);
  expect(result[4]!.blob6).toBe(result[2]!.blob6);
  expect(calculateEventKpi(eventRows(rows), eventPeriod).registration).toEqual([
    { entry: "unknown", stage: "oauth_success", flows: 2 },
    { entry: "unknown", stage: "registered", flows: 1 },
    { entry: "unknown", stage: "existing_login", flows: 1 },
    { entry: "unknown", stage: "profile_complete", flows: 1 },
  ]);
});

test("期間開始の10分前の開始・成功は対応づけに使うが、期間内の段階と新規登録だけ数える", () => {
  const rows = [
    registrationAt("oauth_start", -600000, { flowId: "flow", entry: "room-result" }),
    registrationAt("oauth_success", -1000, { accountId: "before" }),
    registrationAt("registered", -999, { accountId: "before" }),
    registrationAt("profile_complete", 0, { accountId: "before", browserId: "different" }),
    registrationAt("oauth_success", 0),
    registrationAt("registered", 0),
    registrationAt("registered", eventPeriod.toMs - eventPeriod.fromMs, { accountId: "after" }),
  ];
  const result = calculateEventKpi(eventRows(rows), eventPeriod);
  expect(result.newRegistrations).toBe(1);
  expect(result.registration).toEqual([
    { entry: "room-result", stage: "profile_complete", flows: 1 },
    { entry: "room-result", stage: "oauth_success", flows: 1 },
    { entry: "room-result", stage: "registered", flows: 1 },
  ]);
});

test("テストの本人を対応づけ前に除外し、時刻にタイムゾーンがなくてもUTCとして扱う", () => {
  const start = registrationAt("oauth_start", -600000, { flowId: "flow", entry: "login-page" });
  start.timestamp = start.timestamp.replace("T", " ").replace("Z", "");
  const rows = [
    start,
    registrationAt("oauth_success", 0),
    registrationAt("registered", 0),
    registrationAt("registered", 0, { accountId: "test-account", browserId: "other" }),
    registrationAt("registered", 0, { accountId: "other", browserId: "test-browser" }),
    registrationAt("oauth_start", -1, {
      flowId: "test",
      entry: "room-result",
      isTest: true,
      browserId: "test-browser",
      accountId: "test-account",
    }),
  ];
  const result = calculateEventKpi(eventRows(rows), eventPeriod);
  expect(result.newRegistrations).toBe(1);
  expect(result.registration).toEqual([
    { entry: "login-page", stage: "oauth_success", flows: 1 },
    { entry: "login-page", stage: "registered", flows: 1 },
  ]);
});

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
  const result = calculateEventKpi(eventRows(rows), eventPeriod);
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
  expect(calculateEventKpi(eventRows([]), eventPeriod).matchCompletionRate).toEqual(ratio(0, 0));
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
  expect(calculateEventKpi(eventRows(rows), eventPeriod).newRegistrations).toBe(2);
  expect(calculateEventKpi(eventRows([]), eventPeriod).newRegistrations).toBe(0);
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
