import type { KpiQuery } from "@tetraboard/protocol";
import { calculateEventKpi } from "./calculations";
import { kpiPeriod } from "./period";
import { usageDataset, type UsageEventQuery } from "./query";

export async function readEventKpi(
  query: UsageEventQuery,
  datasetName: string | undefined,
  period: KpiQuery,
  nowMs: number,
) {
  const dataset = usageDataset(datasetName);
  const { from, to, toMs } = kpiPeriod(period);
  const grouped = (event: string, columns: string[], until = to) =>
    query.rows(
      `SELECT ${columns.join(", ")}, COUNT(*) AS count FROM ${dataset}
     WHERE blob1 = '${event}' AND timestamp >= $from AND timestamp < $to
     GROUP BY ${columns.join(", ")} ORDER BY ${columns.join(", ")}`,
      { from, to: until },
    );
  const identity = ["blob2", "blob4", "blob5"];
  // client_error も含め、期間内に一度でもテストと記録された本人を除外します。
  const tests = await query.rows(
    `SELECT blob4, blob5, COUNT(*) AS count FROM ${dataset}
     WHERE blob2 = '1' AND timestamp >= $from AND timestamp < $to
     GROUP BY blob4, blob5 ORDER BY blob4, blob5`,
    { from, to },
  );
  const visits = await grouped("visit_started", [
    ...identity,
    "blob8",
    "blob10",
    "blob11",
    "blob12",
    "blob13",
  ]);
  const participants = await grouped("match_participant", [...identity, "blob6"]);
  const starts = await grouped("match_started", ["blob2", "blob6", "double2"]);
  // 期間末をまたいで完了した局も、期間内に開始した局の完了率へ含めます。
  const ends = await grouped(
    "match_ended",
    ["blob6", "blob7"],
    new Date(Math.max(toMs, nowMs)).toISOString(),
  );
  const registration = await grouped("registration", [...identity, "blob6", "blob7", "blob8"]);
  const matchmaking = await grouped("matchmaking", [...identity, "blob7", "double1"]);
  return calculateEventKpi({
    tests,
    visits,
    participants,
    starts,
    ends,
    registration,
    matchmaking,
  });
}
