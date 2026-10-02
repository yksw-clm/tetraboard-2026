import { Fragment, useState } from "react";
import { type RoomMode } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { AppTabs } from "../../shared/ui/AppTabs";
import { formatStatsRate } from "./statsPresentation";
import { useAccountStats } from "./useAccountStats";

function Metric({
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

export function AccountStats() {
  const [mode, setMode] = useState<RoomMode>("singles");
  const { stats, loading, error, refresh } = useAccountStats();
  return (
    <section
      aria-labelledby="account-stats-title"
      className="mt-2 flex flex-col gap-3 border-0 border-t border-solid border-line pt-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="account-stats-title" className="text-lg font-bold">
          戦績
        </h2>
        <AppButton
          appearance="quiet"
          size="compact"
          isDisabled={loading}
          onPress={() => void refresh()}
        >
          更新
        </AppButton>
      </div>
      <AppTabs selectedKey={mode} onSelectionChange={(key) => setMode(key as RoomMode)}>
        <AppTabs.List aria-label="戦績の対局モード">
          <AppTabs.Tab id="singles">
            シングルス
            <AppTabs.Indicator />
          </AppTabs.Tab>
          <AppTabs.Tab id="doubles">
            ダブルス
            <AppTabs.Indicator />
          </AppTabs.Tab>
        </AppTabs.List>
        {(["singles", "doubles"] as const).map((tab) => (
          <AppTabs.Panel key={tab} id={tab} className="pt-4">
            {tab === mode && (
              <div className="flex flex-col gap-3">
                {loading && (
                  <p role="status" className="text-sm text-muted">
                    戦績を読み込んでいます…
                  </p>
                )}
                {stats && (
                  <dl className="m-0 grid grid-cols-2 gap-x-5 gap-y-3">
                    <Metric className="col-span-2" label="対局数" value={stats[mode].total} />
                    {(mode === "singles"
                      ? [
                          { label: "優勝", count: stats.singles.first },
                          { label: "2位", count: stats.singles.second },
                          { label: "3位", count: stats.singles.third },
                          { label: "4位", count: stats.singles.fourth },
                        ]
                      : [
                          { label: "勝", count: stats.doubles.wins },
                          { label: "敗", count: stats.doubles.losses },
                        ]
                    ).map(({ label, count }) => (
                      <Fragment key={label}>
                        <Metric label={`${label}数`} value={count} />
                        <Metric
                          label={`${label}率`}
                          value={formatStatsRate(count, stats[mode].total)}
                        />
                      </Fragment>
                    ))}
                  </dl>
                )}
                {error && (
                  <div className="flex flex-col items-start gap-2">
                    <p role="alert" className="text-sm text-danger">
                      {error}
                    </p>
                    <AppButton appearance="secondary" size="compact" onPress={() => void refresh()}>
                      再試行
                    </AppButton>
                  </div>
                )}
              </div>
            )}
          </AppTabs.Panel>
        ))}
      </AppTabs>
    </section>
  );
}
