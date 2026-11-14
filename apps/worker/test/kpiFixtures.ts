import { usageDataPoint, type UsageEvent } from "../src/usageEvents/events";
import type { EventRows } from "../src/kpi/calculations";
import type { UsageEventQuery, QueryRow } from "../src/kpi/query";

export function eventRow(event: UsageEvent, count = 1): QueryRow {
  const point = usageDataPoint(event);
  return {
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`blob${i + 1}`, point.blobs[i] ?? ""]),
    ),
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`double${i + 1}`, point.doubles[i] ?? 0]),
    ),
    count,
  };
}

export function eventRows(events: QueryRow[]): EventRows {
  const named = (name: string) => events.filter((row) => row.blob1 === name);
  return {
    tests: events.filter((row) => row.blob2 === "1"),
    visits: named("visit_started"),
    participants: named("match_participant"),
    starts: named("match_started"),
    ends: named("match_ended"),
    registration: named("registration"),
    matchmaking: named("matchmaking"),
  };
}

export function fixedUsageQuery(events: QueryRow[]): UsageEventQuery {
  return {
    async rows(sql) {
      const name = /blob1 = '([a-z_]+)'/.exec(sql)?.[1];
      return name
        ? events.filter((row) => row.blob1 === name)
        : events.filter((row) => row.blob2 === "1");
    },
  };
}

export function visit(browserId: string, accountId?: string) {
  return eventRow({
    name: "visit_started",
    isTest: false,
    browserId,
    accountId,
    page: "lobby",
    referrerClass: "search",
    utmSource: "source",
    device: "pc",
  });
}
