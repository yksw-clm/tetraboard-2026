import { expect, test, vi } from "vitest";
import { usageDataPoint, type UsageEvent } from "../src/usageEvents/events";
import { createUsageEventWriter } from "../src/usageEvents/writer";

const common = { isTest: true, game: "four-reversi", browserId: "browser", accountId: "account" };
const cases: { event: UsageEvent; id: string; details: string[]; doubles: number[] }[] = [
  {
    event: {
      ...common,
      name: "match_started",
      matchId: "match",
      mode: "doubles",
      matchKind: "rated",
      humans: 3,
      cpus: 1,
    },
    id: "match",
    details: ["doubles", "rated"],
    doubles: [3, 1],
  },
  {
    event: { ...common, name: "match_participant", matchId: "match", isGuest: true },
    id: "match",
    details: ["1"],
    doubles: [],
  },
  {
    event: {
      ...common,
      name: "match_ended",
      matchId: "match",
      result: "completed",
      reason: "last_player",
      durationMs: 1234,
    },
    id: "match",
    details: ["completed", "last_player"],
    doubles: [1234],
  },
  {
    event: {
      ...common,
      name: "matchmaking",
      operationId: "operation",
      stage: "matched",
      reason: "cpu_capacity",
      rated: true,
      waitingMs: 4567,
      humans: 2,
    },
    id: "operation",
    details: ["matched", "cpu_capacity", "1"],
    doubles: [4567, 2],
  },
  {
    event: {
      ...common,
      name: "registration",
      flowId: "flow",
      stage: "oauth_success",
      entry: "room-result",
    },
    id: "flow",
    details: ["oauth_success", "room-result"],
    doubles: [],
  },
  {
    event: {
      ...common,
      name: "visit_started",
      page: "lobby",
      referrerClass: "search",
      referrerHost: "google.com",
      utmSource: "source",
      utmMedium: "medium",
      utmCampaign: "campaign",
      device: "pc",
    },
    id: "",
    details: ["lobby", "search", "google.com", "source", "medium", "campaign", "pc"],
    doubles: [],
  },
  {
    event: {
      ...common,
      name: "client_error",
      page: "room",
      kind: "unhandledrejection",
      message: "error",
    },
    id: "",
    details: ["room", "unhandledrejection", "error"],
    doubles: [],
  },
];

for (const { event, id, details, doubles } of cases)
  test(`${event.name} の列の並びを固定する`, () => {
    const before = structuredClone(event);
    expect(usageDataPoint(event)).toEqual({
      indexes: [event.name],
      blobs: [event.name, "1", "four-reversi", "browser", "account", id, ...details],
      doubles,
    });
    expect(event).toEqual(before);
  });

test("省略値は空文字と0になり、falseは0になる", () => {
  expect(
    usageDataPoint({
      name: "matchmaking",
      isTest: false,
      operationId: "op",
      stage: "accepted",
      reason: null,
      rated: false,
    }),
  ).toEqual({
    indexes: ["matchmaking"],
    blobs: ["matchmaking", "0", "", "", "", "op", "accepted", "", "0"],
    doubles: [0, 0],
  });
  expect(
    usageDataPoint({ name: "match_participant", isTest: false, matchId: "m", isGuest: false })
      .blobs[6],
  ).toBe("0");
});

test("共通列と詳細列を256文字、エラーメッセージを200文字で切り詰める", () => {
  const long = "あ😀".repeat(150);
  const point = usageDataPoint({
    name: "registration",
    isTest: false,
    game: long,
    browserId: long,
    accountId: long,
    flowId: long,
    stage: "entry",
    entry: "unknown",
  });
  for (const value of point.blobs.slice(2, 6)) expect(Array.from(value)).toHaveLength(256);
  const error = usageDataPoint({
    name: "client_error",
    isTest: false,
    page: long,
    kind: long,
    message: long,
  });
  expect(Array.from(error.blobs[6]!)).toHaveLength(256);
  expect(Array.from(error.blobs[7]!)).toHaveLength(256);
  expect(Array.from(error.blobs[8]!)).toHaveLength(200);
});

test("bindingなしは何もせず、失敗は1行の固定警告だけにする", () => {
  const event = cases[0]!.event;
  expect(() => createUsageEventWriter().write(event)).not.toThrow();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const writer = createUsageEventWriter({
      writeDataPoint() {
        throw new Error("secret");
      },
    });
    expect(() => writer.write(event)).not.toThrow();
    expect(warn.mock.calls).toEqual([["Usage event write failed"]]);
  } finally {
    warn.mockRestore();
  }
});

test("bindingには変換済みの点を同期で渡す", () => {
  let point: unknown;
  createUsageEventWriter({
    writeDataPoint(value) {
      point = value;
    },
  }).write(cases[0]!.event);
  expect(point).toEqual({
    indexes: ["match_started"],
    blobs: [
      "match_started",
      "1",
      "four-reversi",
      "browser",
      "account",
      "match",
      "doubles",
      "rated",
    ],
    doubles: [3, 1],
  });
});

test("1処理の書き込み試行は250点までにし、次の処理で枠を戻す", () => {
  let calls = 0;
  const writer = createUsageEventWriter({
    writeDataPoint() {
      calls++;
    },
  });
  for (let i = 0; i < 300; i++) writer.write(cases[0]!.event);
  expect(calls).toBe(250);
  const next = createUsageEventWriter({
    writeDataPoint() {
      calls++;
    },
  });
  next.write(cases[0]!.event);
  expect(calls).toBe(251);
});

test("失敗した試行も250点の上限に含める", () => {
  let calls = 0;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const writer = createUsageEventWriter({
      writeDataPoint() {
        calls++;
        throw new Error("unavailable");
      },
    });
    for (let i = 0; i < 300; i++) writer.write(cases[0]!.event);
    expect(calls).toBe(250);
    expect(warn).toHaveBeenCalledTimes(250);
  } finally {
    warn.mockRestore();
  }
});
