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

export type EventRows = {
  tests: QueryRow[];
  visits: QueryRow[];
  participants: QueryRow[];
  starts: QueryRow[];
  ends: QueryRow[];
  registration: QueryRow[];
  matchmaking: QueryRow[];
};

export function calculateEventKpi(rows: EventRows): EventKpi & { newRegistrations: number } {
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
  for (const row of rows.registration.filter(eligible)) {
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
