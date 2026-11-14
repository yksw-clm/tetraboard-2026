import { kpiQuerySchema, type KpiQuery } from "@tetraboard/protocol";

export const dayMs = 86400000;
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

export function previousJapanMonth(nowMs: number): KpiQuery & { month: string } {
  const current = new Date(japanDayStart(nowMs) + japanOffsetMs);
  const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0));
  const to = end.toISOString().slice(0, 10);
  const month = to.slice(0, 7);
  return { month, from: `${month}-01`, to };
}
