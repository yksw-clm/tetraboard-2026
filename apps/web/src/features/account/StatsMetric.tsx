export function StatsMetric({
  label,
  value,
  className = "",
}: {
  label: string;
  value: number | string;
  className?: string;
}) {
  return (
    <div
      className={`flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1 ${className}`}
    >
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="m-0 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
