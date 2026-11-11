import type { AdminAnalytics, AnalyticsMetrics } from "@tetraboard/protocol";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "./components/ui/chart";
import { quantity } from "./presentation";
const trendConfig = {
  visitors: { label: "訪問ブラウザ", color: "var(--chart-1)" },
  started: { label: "開始対局", color: "var(--chart-2)" },
  completed: { label: "完了対局", color: "var(--chart-3)" },
} satisfies ChartConfig;
export function TrendChart({ buckets }: Pick<AdminAnalytics, "buckets">) {
  const data = buckets.map((row) => ({ ...row.metrics, period: row.period }));
  return (
    <figure className="m-0 min-w-0" aria-label="訪問・対局の推移">
      <ChartContainer
        config={trendConfig}
        className="h-[280px] w-full"
        aria-label="訪問ブラウザ数・開始対局数・完了対局数の折れ線グラフ。正確な数値は集計表に表示します。"
      >
        <AreaChart accessibilityLayer data={data} margin={{ left: 0, right: 12, top: 16 }}>
          <defs>
            {Object.keys(trendConfig).map((key) => (
              <linearGradient key={key} id={`fill-${key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`var(--color-${key})`} stopOpacity={0.35} />
                <stop offset="100%" stopColor={`var(--color-${key})`} stopOpacity={0.03} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="period"
            tickLine={false}
            axisLine={false}
            minTickGap={36}
            tickMargin={10}
            tickFormatter={(v) => String(v).slice(5)}
          />
          <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={quantity} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {Object.keys(trendConfig).map((key) => (
            <Area
              key={key}
              dataKey={key}
              type="monotone"
              stroke={`var(--color-${key})`}
              fill={`url(#fill-${key})`}
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ChartContainer>
      {buckets.some(
        (row) =>
          row.metrics.visitors === null ||
          row.metrics.started === null ||
          row.metrics.completed === null,
      ) && (
        <figcaption className="text-xs text-muted-foreground">
          期間の一部を算出できません。欠測区間を0で補っていません。
        </figcaption>
      )}
    </figure>
  );
}
const breakdownConfig = { count: { label: "対局", color: "var(--chart-1)" } } satisfies ChartConfig;
export function BreakdownChart({ metrics }: { metrics: AnalyticsMetrics }) {
  const data = [
    { label: "CPU戦", count: metrics.cpuMatches },
    { label: "対人戦", count: metrics.humanMatches },
    { label: "シングルス", count: metrics.singles },
    { label: "ダブルス", count: metrics.doubles },
  ];
  return (
    <ChartContainer
      config={breakdownConfig}
      className="h-[280px] w-full"
      role="img"
      aria-label={`対局の内訳：${data.map((row) => `${row.label}${row.count}局`).join("、")}`}
    >
      <BarChart
        accessibilityLayer
        layout="vertical"
        data={data}
        margin={{ left: 0, right: 16, top: 16, bottom: 16 }}
      >
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} width={85} />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={4} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}
