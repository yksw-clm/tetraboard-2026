import { kpiReportSchema, type KpiQuery, type KpiReport } from "@tetraboard/protocol";
import { readBusinessKpi } from "./business";
import { readEventKpi } from "./events";
import { createUsageEventQuery, type KpiEnv, type UsageEventQuery } from "./query";

export async function readKpi(
  env: KpiEnv,
  query: KpiQuery,
  nowMs = Date.now(),
  usageQuery: UsageEventQuery = createUsageEventQuery(env),
): Promise<KpiReport> {
  const business = await readBusinessKpi(env, query, nowMs);
  let events: KpiReport["events"] = null;
  let newRegistrations: KpiReport["newRegistrations"] = null;
  let eventsUnavailableReason: string | null = null;
  try {
    const { newRegistrations: registered, ...values } = await readEventKpi(
      usageQuery,
      env.USAGE_EVENTS_DATASET,
      query,
      nowMs,
    );
    events = values;
    newRegistrations = registered;
  } catch {
    // SQL エラーには識別子等が含まれ得るため、その本文を応答へ出しません。
    eventsUnavailableReason = "利用状況イベントを取得できません。時間をおいて再試行してください。";
  }
  return kpiReportSchema.parse({
    ...query,
    computedAtMs: nowMs,
    ...business,
    newRegistrations,
    events,
    eventsUnavailableReason,
    // 新 SQL API の _sample_interval 列は未確認のため問い合わせません。
    sampling: "unknown",
  });
}
