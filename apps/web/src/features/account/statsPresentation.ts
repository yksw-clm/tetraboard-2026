export function formatStatsRate(count: number, total: number): string {
  const rounded = total === 0 ? 0 : Math.round((count * 1000) / total) / 1000;
  return rounded.toFixed(3).replace(/^0\./, ".");
}
