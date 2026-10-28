import type { AdminAnalytics, AnalyticsMetrics } from "@tetraboard/protocol";
import { quantity } from "./presentation";
const series: { key: keyof AnalyticsMetrics; name: string; color: string }[] = [
  { key: "visitors", name: "訪問ブラウザ", color: "#246b50" },
  { key: "started", name: "開始対局", color: "#4479ba" },
  { key: "completed", name: "完了対局", color: "#bc7e22" },
];
export function TrendChart({ buckets }: Pick<AdminAnalytics, "buckets">) {
  const maximum = Math.max(
    1,
    ...buckets.flatMap((row) => series.map((s) => Number(row.metrics[s.key]))),
  );
  const x = (index: number) => 48 + (index / Math.max(1, buckets.length - 1)) * 690;
  const y = (value: number) => 220 - (value / maximum) * 170;
  return (
    <figure className="m-0" aria-label="訪問・対局の推移">
      <svg
        viewBox="0 0 780 270"
        className="w-full"
        role="img"
        aria-label="訪問ブラウザ数・開始対局数・完了対局数の折れ線グラフ。正確な数値は集計表に表示します。"
      >
        {[0, 0.5, 1].map((ratio) => (
          <g key={ratio}>
            <line
              x1="48"
              x2="738"
              y1={y(maximum * ratio)}
              y2={y(maximum * ratio)}
              stroke="#dde5e0"
            />
            <text x="40" y={y(maximum * ratio) + 4} textAnchor="end" fontSize="12" fill="#53665c">
              {quantity(maximum * ratio)}
            </text>
          </g>
        ))}
        {series
          .filter((s) => buckets.every((row) => row.metrics[s.key] !== null))
          .map((s) => (
            <g key={s.key}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth="3"
                points={buckets
                  .map((row, index) => `${x(index)},${y(Number(row.metrics[s.key]))}`)
                  .join(" ")}
              />
              {buckets.length === 1 && (
                <circle cx={x(0)} cy={y(Number(buckets[0].metrics[s.key]))} r="4" fill={s.color} />
              )}
            </g>
          ))}
        {buckets
          .filter(
            (_, i) => i === 0 || i === buckets.length - 1 || i === Math.floor(buckets.length / 2),
          )
          .map((row) => (
            <text
              key={row.period}
              x={x(buckets.indexOf(row))}
              y="248"
              textAnchor="middle"
              fontSize="12"
              fill="#53665c"
            >
              {row.period}
            </text>
          ))}
      </svg>
      <figcaption className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-2">
            <span className="h-2 w-5 rounded" style={{ background: s.color }} />
            {s.name}
            {buckets.some((row) => row.metrics[s.key] === null)
              ? "（期間の一部を算出できません）"
              : ""}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
export function BreakdownChart({ metrics }: { metrics: AnalyticsMetrics }) {
  const pairs = [
    ["CPU戦", metrics.cpuMatches, "#4479ba"],
    ["対人戦", metrics.humanMatches, "#246b50"],
    ["シングルス", metrics.singles, "#bc7e22"],
    ["ダブルス", metrics.doubles, "#875b9b"],
  ] as const;
  const maximum = Math.max(1, ...pairs.map(([, value]) => value));
  return (
    <svg
      viewBox="0 0 500 180"
      role="img"
      className="w-full"
      aria-label={`対局の内訳：${pairs.map(([label, count]) => `${label}${count}局`).join("、")}`}
    >
      {pairs.map(([label, value, color], index) => (
        <g key={label}>
          <text x="0" y={index * 40 + 23} fontSize="14" fill="#21352d">
            {label}
          </text>
          <rect
            x="100"
            y={index * 40 + 5}
            height="25"
            width={(value / maximum) * 330}
            rx="4"
            fill={color}
          />
          <text x="490" y={index * 40 + 23} textAnchor="end" fontSize="14" fill="#21352d">
            {quantity(value)}
          </text>
        </g>
      ))}
    </svg>
  );
}
