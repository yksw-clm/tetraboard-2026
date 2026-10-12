type Metric = { label: string; value: number | string };
export type StatsRow = readonly [Metric, Metric?];

export function StatsTable({ rows, label }: { rows: StatsRow[]; label: string }) {
  return (
    <table aria-label={label} className="w-full table-fixed border-collapse text-sm">
      <tbody>
        {rows.map((row) => (
          <tr key={row[0].label}>
            {[row[0], row[1]].map((metric, index) => (
              <td key={index} className="border border-solid border-line px-3 py-2 align-middle">
                {metric && (
                  <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-muted">{metric.label}</span>
                    <span className="font-semibold tabular-nums">{metric.value}</span>
                  </span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
