export const percent = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;
export const quantity = (value: number | null) =>
  value === null ? "—" : new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(value);
export function duration(value: number | null) {
  return value === null
    ? "—"
    : value >= 3600000
      ? `${quantity(value / 3600000)}時間`
      : `${quantity(value / 60000)}分`;
}
export function defaultPeriod(bucket: "day" | "month", now = Date.now()) {
  const today = new Date(now + 32400000);
  const to = today.toISOString().slice(0, 10);
  const from =
    bucket === "day"
      ? new Date(today.getTime() - 29 * 86400000)
      : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  return { from: from.toISOString().slice(0, 10), to };
}
