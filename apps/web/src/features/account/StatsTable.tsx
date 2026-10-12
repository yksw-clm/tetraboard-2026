type Metric = { label: string; value: number | string };
export type StatsRow = readonly [Metric, Metric?];

export function StatsTable({ rows, label }: { rows: StatsRow[]; label: string }) {
  return (
    <div className="overflow-hidden rounded-control border border-solid border-line/70 bg-white">
      <table aria-label={label} className="w-full table-fixed border-collapse text-sm">
        <tbody>
          {rows.map((row) => (
            <tr
              key={row[0].label}
              className="border-0 border-b border-solid border-line/50 first:bg-surface-muted/70 last:border-b-0"
            >
              {[row[0], row[1]].map((metric, index) => (
                <td key={index} className="px-3 py-3 align-middle sm:px-4">
                  {metric && (
                    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-muted">{metric.label}</span>
                      <span className="text-base font-semibold tabular-nums">{metric.value}</span>
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
