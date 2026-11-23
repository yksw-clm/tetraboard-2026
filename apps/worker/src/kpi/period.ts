import { kpiQuerySchema, kpiWeekCount, type KpiQuery } from "@tetraboard/protocol";

export const dayMs = 86400000;
export const weekMs = 7 * dayMs;
const japanOffsetMs = 9 * 3600000;

export function japanDayStart(atMs: number): number {
  return Math.floor((atMs + japanOffsetMs) / dayMs) * dayMs - japanOffsetMs;
}

/** API の両端を含む日本時間の日付を、UTC の半開区間へ変換します。 */
export function kpiPeriod(input: KpiQuery) {
  const { from, to } = kpiQuerySchema.parse(input);
  const fromMs = Date.parse(`${from}T00:00:00+09:00`);
  const toMs = Date.parse(`${to}T00:00:00+09:00`) + dayMs;
  return { fromMs, toMs, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

/** 選択した終了日を含む週からさかのぼり、日本時間の月曜で区切ります。 */
export function kpiWeeks(periodEndMs: number, nowMs: number) {
  const lastDayMs = periodEndMs - dayMs;
  const daysSinceMonday = (new Date(lastDayMs + japanOffsetMs).getUTCDay() + 6) % 7;
  const lastWeekStartMs = lastDayMs - daysSinceMonday * dayMs;
  const fromMs = lastWeekStartMs - (kpiWeekCount - 1) * weekMs;
  const toMs = lastWeekStartMs + weekMs;
  const weeks = Array.from({ length: kpiWeekCount }, (_, index) => {
    const startMs = fromMs + index * weekMs;
    return {
      weekStart: new Date(startMs + japanOffsetMs).toISOString().split("T")[0],
      partial: startMs + weekMs > nowMs,
    };
  });
  return { fromMs, toMs, weeks };
}

export function previousJapanMonth(nowMs: number): KpiQuery & { month: string } {
  const current = new Date(japanDayStart(nowMs) + japanOffsetMs);
  const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0));
  const to = end.toISOString().slice(0, 10);
  const month = to.slice(0, 7);
  return { month, from: `${month}-01`, to };
}
