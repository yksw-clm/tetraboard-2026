import type { EventKpi, KpiRatio } from "@tetraboard/protocol";
import { dayMs, japanDayStart } from "./period";
import type { QueryRow } from "./query";

export function ratio(numerator: number, denominator: number): KpiRatio {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

export function waitingPercentiles(values: { value: number; count: number }[]) {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, row) => sum + row.count, 0);
  if (!total) return { median: null, p90: null };
  const atRank = (rank: number) => {
    let count = 0;
    for (const row of sorted) {
      count += row.count;
      if (count >= rank) return row.value;
    }
    throw new Error("Invalid waiting time distribution");
  };
  return {
    median: (atRank(Math.ceil(total / 2)) + atRank(Math.floor(total / 2) + 1)) / 2,
    p90: atRank(Math.ceil(total * 0.9)),
  };
}

export type CompletedParticipation = { accountId: string; matchId: string; endedAtMs: number };

/** 入力には、各アカウントの全期間の初回完了と、観測期限までの完了を含めます。 */
export function replayWithin7Days(
  rows: CompletedParticipation[],
  period: { fromMs: number; toMs: number },
  nowMs: number,
) {
  const accounts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.endedAtMs > nowMs) continue;
    const matches = accounts.get(row.accountId) ?? new Map<string, number>();
    matches.set(row.matchId, row.endedAtMs);
    accounts.set(row.accountId, matches);
  }
  let denominator = 0,
    numerator = 0,
    observing = 0;
  for (const matches of accounts.values()) {
    const times = [...matches.values()].sort((a, b) => a - b);
    const first = times[0]!;
    if (first < period.fromMs || first >= period.toMs) continue;
    const nextDay = japanDayStart(first) + dayMs;
    const end = nextDay + 7 * dayMs;
    if (nowMs < end) {
      observing++;
      continue;
    }
    denominator++;
    if (times.some((at) => at >= nextDay && at < end)) numerator++;
  }
  return { ...ratio(numerator, denominator), observing };
}

const text = (row: QueryRow, column: string): string => {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`Invalid event column: ${column}`);
  return value;
};
const number = (row: QueryRow, column: string): number => {
  const value = row[column];
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    value === "" ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  )
    throw new Error(`Invalid event column: ${column}`);
  return Number(value);
};

export const registrationLookbackMs = 10 * 60 * 1000;

function registrationTimestamp(row: QueryRow) {
  const timestamp = text(row, "timestamp");
  // Analytics Engine のタイムゾーンなしの時刻も UTC として扱います。
  const atMs = Date.parse(
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? timestamp : `${timestamp.replace(" ", "T")}Z`,
  );
  if (!Number.isFinite(atMs)) throw new Error("Invalid registration timestamp");
  return atMs;
}

/** 同時刻の開始・成功を「直前」とせず、入力を変更せずに手続きへ対応づけます。 */
export function attributeRegistrationEvents(rows: QueryRow[]): QueryRow[] {
  const events = rows
    .map((row) => ({ row: { ...row }, atMs: registrationTimestamp(row) }))
    .sort((a, b) => a.atMs - b.atMs);
  type Event = (typeof events)[number];
  const starts = new Map<string, Event>();
  const successes = new Map<string, Event>();
  const unpaired = new Map<string, QueryRow>();
  const identity = (row: QueryRow) => JSON.stringify([text(row, "blob5"), text(row, "blob4")]);
  const inherit = (row: QueryRow, source: QueryRow) => {
    row.blob6 = text(source, "blob6");
    row.blob8 = text(source, "blob8");
  };
  for (let i = 0; i < events.length;) {
    let end = i + 1;
    while (end < events.length && events[end]!.atMs === events[i]!.atMs) end++;
    const simultaneous = events.slice(i, end);
    const unmatched: QueryRow[] = [];
    for (const { row, atMs } of simultaneous) {
      if (text(row, "blob6")) continue;
      const stage = text(row, "blob7");
      if (["oauth_success", "registered", "existing_login"].includes(stage)) {
        const browser = text(row, "blob4");
        const start = browser ? starts.get(browser) : undefined;
        if (start && atMs - start.atMs <= registrationLookbackMs) {
          inherit(row, start.row);
          continue;
        }
        unmatched.push(row);
      } else if (stage === "profile_complete") {
        const account = text(row, "blob5");
        const success = account ? successes.get(account) : undefined;
        if (success) {
          inherit(row, success.row);
          continue;
        }
      } else continue;
      row.blob6 = JSON.stringify(["unknown", identity(row), atMs]);
      row.blob8 = "unknown";
    }
    // 連続して書かれる完了の2点は、時刻が少しずれても同じ手続きにします。
    for (const { row } of simultaneous)
      if (text(row, "blob7") === "oauth_success") unpaired.delete(identity(row));
    for (const row of unmatched)
      if (text(row, "blob7") === "oauth_success") unpaired.set(identity(row), row);
    for (const row of unmatched) {
      if (text(row, "blob7") === "oauth_success") continue;
      const key = identity(row);
      const success = unpaired.get(key);
      if (success) {
        inherit(row, success);
        unpaired.delete(key);
      }
    }
    for (const event of simultaneous) {
      const { row } = event;
      if (text(row, "blob7") === "oauth_start" && text(row, "blob6") && text(row, "blob4"))
        starts.set(text(row, "blob4"), event);
      if (text(row, "blob7") === "oauth_success" && text(row, "blob5"))
        successes.set(text(row, "blob5"), event);
    }
    i = end;
  }
  return events.map(({ row }) => row);
}

export type EventRows = {
  tests: QueryRow[];
  visits: QueryRow[];
  participants: QueryRow[];
  starts: QueryRow[];
  ends: QueryRow[];
  registration: QueryRow[];
  matchmaking: QueryRow[];
};

export function calculateEventKpi(
  rows: EventRows,
  period: { fromMs: number; toMs: number },
): EventKpi & { newRegistrations: number } {
  const testBrowsers = new Set(rows.tests.map((r) => text(r, "blob4")).filter(Boolean));
  const testAccounts = new Set(rows.tests.map((r) => text(r, "blob5")).filter(Boolean));
  const eligible = (r: QueryRow) =>
    text(r, "blob2") !== "1" &&
    !testBrowsers.has(text(r, "blob4")) &&
    !testAccounts.has(text(r, "blob5"));
  const testMatches = new Set(
    rows.starts.filter((r) => text(r, "blob2") === "1").map((r) => text(r, "blob6")),
  );
  const starts = new Map(
    rows.starts.filter((r) => !testMatches.has(text(r, "blob6"))).map((r) => [text(r, "blob6"), r]),
  );
  const completed = new Set(
    rows.ends.filter((r) => text(r, "blob7") === "completed").map((r) => text(r, "blob6")),
  );
  const participants = new Set(
    rows.participants
      .filter((r) => eligible(r) && !testMatches.has(text(r, "blob6")))
      .map((r) => text(r, "blob4"))
      .filter(Boolean),
  );
  const visits = rows.visits.filter(eligible);
  const browsers = new Set(visits.map((r) => text(r, "blob4")).filter(Boolean));
  const participating = (ids: Set<string>) => [...ids].filter((id) => participants.has(id)).length;
  const acquisition = new Map<string, { columns: string[]; browsers: Set<string> }>();
  for (const row of visits) {
    const browser = text(row, "blob4");
    if (!browser) continue;
    const columns = ["blob8", "blob10", "blob11", "blob12", "blob13"].map((column) =>
      text(row, column),
    );
    const key = JSON.stringify(columns);
    const group = acquisition.get(key) ?? { columns, browsers: new Set<string>() };
    group.browsers.add(browser);
    acquisition.set(key, group);
  }
  const registration = new Map<string, { entry: string; stage: string; ids: Set<string> }>();
  const registeredAccounts = new Set<string>();
  const attributed = attributeRegistrationEvents(rows.registration.filter(eligible));
  for (const row of attributed) {
    const atMs = registrationTimestamp(row);
    if (atMs < period.fromMs || atMs >= period.toMs) continue;
    const stage = text(row, "blob7");
    const accountId = text(row, "blob5");
    if (stage === "registered" && accountId) registeredAccounts.add(accountId);
    const id = text(row, "blob6");
    if (!id) continue;
    const entry = text(row, "blob8");
    const key = JSON.stringify([entry, stage]);
    const group = registration.get(key) ?? { entry, stage, ids: new Set<string>() };
    group.ids.add(id);
    registration.set(key, group);
  }
  const matchmaking = new Map<
    string,
    { count: number; waits: { value: number; count: number }[] }
  >();
  for (const row of rows.matchmaking.filter(eligible)) {
    const stage = text(row, "blob7"),
      count = number(row, "count");
    const group = matchmaking.get(stage) ?? { count: 0, waits: [] };
    group.count += count;
    group.waits.push({ value: number(row, "double1"), count });
    matchmaking.set(stage, group);
  }
  return {
    newRegistrations: registeredAccounts.size,
    visitingBrowsers: browsers.size,
    matchStartRate: ratio(participating(browsers), browsers.size),
    matchCompletionRate: ratio(
      [...starts.keys()].filter((id) => completed.has(id)).length,
      starts.size,
    ),
    humanMatchRate: ratio(
      [...starts.values()].filter((r) => number(r, "double2") === 0).length,
      starts.size,
    ),
    acquisition: [...acquisition.values()].map(({ columns, browsers }) => ({
      referrerClass: columns[0]!,
      utmSource: columns[1]!,
      utmMedium: columns[2]!,
      utmCampaign: columns[3]!,
      device: columns[4]!,
      visitingBrowsers: browsers.size,
      participatingBrowsers: participating(browsers),
    })),
    registration: [...registration.values()].map(({ entry, stage, ids }) => ({
      entry,
      stage,
      flows: ids.size,
    })),
    matchmaking: [...matchmaking].map(([stage, group]) => ({
      stage,
      count: group.count,
      waitingMs: waitingPercentiles(group.waits),
    })),
  };
}
