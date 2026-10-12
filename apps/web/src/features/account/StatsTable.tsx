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
                <td key={index} className="px-2 py-3 align-top sm:px-4">
                  {metric && (
                    <span className="grid grid-cols-[4em_minmax(0,1fr)] items-baseline gap-x-2 sm:grid-cols-[5em_minmax(0,1fr)]">
                      <span className="min-w-0 text-muted wrap-anywhere">{metric.label}</span>
                      <span className="min-w-0 text-base font-semibold tabular-nums wrap-anywhere">
                        {metric.value}
                      </span>
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
