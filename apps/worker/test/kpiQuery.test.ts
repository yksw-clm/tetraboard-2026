import { expect, test, vi } from "vitest";
import { createUsageEventQuery, usageDataset, type QueryRow } from "../src/kpi/query";
import { readEventKpi } from "../src/kpi/events";

const queryResult = (data: QueryRow[]): AnalyticsSQLResult => ({
  data,
  rows: data.length,
  statistics: { elapsed_ms: 0, rows_read: data.length, bytes_read: 0 },
});

function sqlBinding(
  query: (input: AnalyticsSQLQuery) => Promise<AnalyticsSQLResult>,
): AnalyticsSQLBinding {
  return {
    async query<T extends QueryRow = QueryRow>(
      input: AnalyticsSQLQuery,
    ): Promise<AnalyticsSQLResult<T>> {
      const result = await query(input);
      return { ...result, data: result.data as T[] };
    },
  };
}

test("データセット名は識別子だけ許可する", () => {
  expect(usageDataset("events_dev")).toBe('events.analyticsEngine."events_dev"');
  for (const value of [undefined, "", 'a";DROP', "a.b", "a-b", "a\n"])
    expect(() => usageDataset(value)).toThrow();
});

test("サーバーの上限が小さくても空ページまで読み、オフセットは返った行数だけ進める", async () => {
  const params = { from: "2026-10-31T15:00:00Z", to: "2026-11-01T15:00:00Z" };
  const fake = vi
    .fn<(input: AnalyticsSQLQuery) => Promise<AnalyticsSQLResult>>()
    .mockResolvedValueOnce(queryResult([{ n: 1 }, { n: 2 }]))
    .mockResolvedValueOnce(queryResult([{ n: 3 }]))
    .mockResolvedValueOnce(queryResult([]));
  const query = createUsageEventQuery({
    APP_DB: {} as D1Database,
    ANALYTICS_SQL: sqlBinding(fake),
  });
  expect(await query.rows("SELECT blob4 FROM events", params)).toEqual([
    { n: 1 },
    { n: 2 },
    { n: 3 },
  ]);
  for (const [input] of fake.mock.calls) expect(input.params).toEqual(params);
  expect(fake.mock.calls.map(([input]) => input.query.match(/LIMIT.*$/)?.[0])).toEqual([
    "LIMIT 10000 OFFSET 0",
    "LIMIT 10000 OFFSET 2",
    "LIMIT 10000 OFFSET 3",
  ]);
});

test("20ページを超えたら部分結果を返さず失敗する", async () => {
  const fake = vi
    .fn<(input: AnalyticsSQLQuery) => Promise<AnalyticsSQLResult>>()
    .mockResolvedValue(queryResult([{ n: 1 }]));
  const query = createUsageEventQuery({
    APP_DB: {} as D1Database,
    ANALYTICS_SQL: sqlBinding(fake),
  });
  await expect(query.rows("SELECT count", {})).rejects.toThrow("20 pages");
  expect(fake).toHaveBeenCalledTimes(20);
});

test("retryable=true だけを2回まで再試行し、成功すれば次ページへ進む", async () => {
  const temporary = Object.assign(new Error("secret"), { retryable: true });
  const fake = vi
    .fn<(input: AnalyticsSQLQuery) => Promise<AnalyticsSQLResult>>()
    .mockRejectedValueOnce(temporary)
    .mockRejectedValueOnce(temporary)
    .mockResolvedValueOnce(queryResult([]));
  const query = createUsageEventQuery({
    APP_DB: {} as D1Database,
    ANALYTICS_SQL: sqlBinding(fake),
  });
  await expect(query.rows("SELECT count", {})).resolves.toEqual([]);
  expect(fake).toHaveBeenCalledTimes(3);
  fake.mockReset().mockRejectedValue(temporary);
  await expect(query.rows("SELECT count", {})).rejects.toThrow("secret");
  expect(fake).toHaveBeenCalledTimes(3);
  fake.mockReset().mockRejectedValue(Object.assign(new Error("invalid"), { retryable: false }));
  await expect(query.rows("SELECT count", {})).rejects.toThrow("invalid");
  expect(fake).toHaveBeenCalledTimes(1);
});

test("登録だけは10分前から時刻順で1点ずつ読み、他のクエリは期間内で集約する", async () => {
  const calls: { query: string; params: Record<string, unknown> }[] = [];
  const now = Date.parse("2026-12-02T00:00:00Z");
  await readEventKpi(
    {
      async rows(query, params) {
        calls.push({ query, params });
        return [];
      },
    },
    "usage",
    { from: "2026-11-01", to: "2026-11-30" },
    now,
  );
  expect(calls).toHaveLength(7);
  for (const { query, params } of calls) {
    expect(query).toContain('FROM events.analyticsEngine."usage"');
    expect(query).toContain("timestamp >= $from AND timestamp < $to");
    expect(query).toContain("ORDER BY");
    expect(query).not.toMatch(/JOIN|FORMAT|_sample_interval|quantile/i);
    if (query.includes("'registration'")) {
      expect(query).toContain("SELECT timestamp, blob2, blob4, blob5, blob6, blob7, blob8, blob3");
      expect(query).toContain("ORDER BY timestamp ASC");
      expect(query).not.toMatch(/COUNT|GROUP BY/);
      expect(params).toEqual({ from: "2026-10-31T14:50:00.000Z", to: "2026-11-30T15:00:00.000Z" });
    } else {
      expect(query).toContain("COUNT(*)");
      expect(query).toContain("GROUP BY");
      expect(params.from).toBe("2026-10-31T15:00:00.000Z");
    }
  }
  expect(calls.find((call) => call.query.includes("'match_ended'"))?.params.to).toBe(
    new Date(now).toISOString(),
  );
});
