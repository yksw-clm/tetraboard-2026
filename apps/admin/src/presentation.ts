import type { AnalyticsMetrics } from "@tetraboard/protocol";
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
export function metricCards(m: AnalyticsMetrics, totalUsers: number) {
  return [
    ["訪問ブラウザ", quantity(m.visitors)],
    ["ページ閲覧", quantity(m.pageViews)],
    ["表示中の滞在時間", duration(m.dwellMs)],
    ["登録ユーザー総数", quantity(totalUsers)],
    ["新規登録", quantity(m.newUsers)],
    ["訪問からの対局開始率", percent(m.startRate)],
    ["開始対局", quantity(m.started)],
    ["完了対局", quantity(m.completed)],
    ["打ち切り", quantity(m.abandoned)],
    ["進行中", quantity(m.playing)],
    ["完了率", percent(m.completionRate)],
    ["平均対局時間（完了局）", duration(m.completed ? m.completedDurationMs / m.completed : null)],
    ["延べ対局参加時間", duration(m.participationMs)],
    ["登録利用者", quantity(m.registeredActive)],
    ["ゲスト利用ブラウザ", quantity(m.guestActive)],
    [
      "登録IDあたりの対局数",
      m.registeredActive ? quantity((m.registeredParticipations ?? 0) / m.registeredActive) : "—",
    ],
    [
      "ゲストIDあたりの対局数",
      m.guestActive ? quantity((m.guestParticipations ?? 0) / m.guestActive) : "—",
    ],
    ["登録・7日以内の再対局率", percent(m.registeredRetentionRate)],
    ["ゲスト・7日以内の再対局率", percent(m.guestRetentionRate)],
  ];
}
