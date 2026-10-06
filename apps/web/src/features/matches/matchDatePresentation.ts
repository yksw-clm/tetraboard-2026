const dateFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatMatchDate(startedAtMs: number, relativeToMs?: number): string {
  if (relativeToMs !== undefined) {
    const elapsedMs = relativeToMs - startedAtMs;
    if (elapsedMs >= 0 && elapsedMs <= 60 * 60_000) return `${Math.floor(elapsedMs / 60_000)}分前`;
    if (elapsedMs > 60 * 60_000 && elapsedMs <= 24 * 60 * 60_000)
      return `${Math.floor(elapsedMs / (60 * 60_000))}時間前`;
  }
  return dateFormat.format(startedAtMs);
}
