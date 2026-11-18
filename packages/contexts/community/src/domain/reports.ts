const reportRetentionMs = 7 * 24 * 60 * 60 * 1000;
const reportIntervalMs = 3_000;
export const reportPageSize = 20;

export type ReportCursor = { time: number; id: string };

export function reportSubmissionWindow(now: number) {
  return { expiresAtMs: now + reportRetentionMs, precedingReportAfter: now - reportIntervalMs };
}

export function parseReportCursor(cursor: string | undefined): ReportCursor | null {
  if (cursor === undefined) return null;
  const parts = cursor.split(":");
  if (
    parts.length !== 2 ||
    !/^\d{1,16}$/.test(parts[0]) ||
    !Number.isSafeInteger(Number(parts[0])) ||
    !/^[0-9a-f-]{36}$/.test(parts[1])
  )
    throw new Error("Invalid cursor");
  return { time: Number(parts[0]), id: parts[1] };
}

export function reportPage<Row, Report>(
  rows: Row[],
  toReport: (row: Row) => Report,
  position: (row: Row) => ReportCursor,
) {
  const reports = rows.slice(0, reportPageSize).map(toReport);
  const last = rows[reportPageSize - 1];
  if (rows.length <= reportPageSize || last === undefined) return { reports, nextCursor: null };
  const { time, id } = position(last);
  return { reports, nextCursor: `${time}:${id}` };
}
