import type { KpiReport } from "@tetraboard/protocol";
import { previousJapanMonth } from "./period";
import type { KpiEnv } from "./query";
import { readKpi } from "./report";

export function monthlyValues(report: KpiReport): Record<string, number> {
  if (!report.events || report.newRegistrations === null) throw new Error("Monthly KPI incomplete");
  const values: Record<string, number> = {
    visitingBrowsers: report.events.visitingBrowsers,
    completedMatches: report.completedMatches,
    players: report.players,
    newRegistrations: report.newRegistrations,
    "replayWithin7Days.observing": report.replayWithin7Days.observing,
  };
  for (const [name, value] of Object.entries({
    matchStartRate: report.events.matchStartRate,
    matchCompletionRate: report.events.matchCompletionRate,
    humanMatchRate: report.events.humanMatchRate,
    replayWithin7Days: report.replayWithin7Days,
  })) {
    values[`${name}.numerator`] = value.numerator;
    values[`${name}.denominator`] = value.denominator;
    if (value.rate !== null) values[`${name}.rate`] = value.rate;
  }
  return values;
}

export async function savePreviousMonthKpi(env: KpiEnv, nowMs = Date.now()): Promise<void> {
  const period = previousJapanMonth(nowMs);
  if (
    await env.APP_DB.prepare("SELECT 1 FROM kpi_monthly WHERE month=? LIMIT 1")
      .bind(period.month)
      .first()
  )
    return;
  const values = monthlyValues(await readKpi(env, { from: period.from, to: period.to }, nowMs));
  // 全指標を同じトランザクションで保存し、失敗時に一部の行だけを残しません。
  await env.APP_DB.batch(
    Object.entries(values).map(([metric, value]) =>
      env.APP_DB.prepare(
        `INSERT OR IGNORE INTO kpi_monthly(month,metric,value,computed_at_ms) VALUES(?,?,?,?)`,
      ).bind(period.month, metric, value, nowMs),
    ),
  );
}
