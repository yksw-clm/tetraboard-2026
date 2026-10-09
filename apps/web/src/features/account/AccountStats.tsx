import { gameCatalog } from "@tetraboard/protocol/games";
import { Fragment, lazy, Suspense } from "react";
import { type MatchGame, type RoomMode } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { formatStatsRate } from "./statsPresentation";
import { StatsMetric as Metric } from "./StatsMetric";
import { useFormationStats } from "./useFormationStats";
import { useAccountStats } from "./useAccountStats";
import { AccountBadges } from "../badges/AccountBadges";
const FormationStats = lazy(() => import("./FormationStats"));

export function AccountStats({ game, mode }: { game: MatchGame; mode: RoomMode }) {
  const { stats, loading, error, pendingSource, refresh } = useAccountStats(game);
  const showFormations = game === "four-shogi" && mode === "singles";
  const formations = useFormationStats(showFormations);
  return (
    <>
      {gameCatalog[game].hasModes && mode === "singles" && stats && (
        <div className="mt-2 border-0 border-t border-solid border-line pt-5">
          <AccountBadges game={game} stats={stats} />
        </div>
      )}
      <section
        aria-labelledby="account-stats-title"
        className="mt-2 min-w-0 flex flex-col gap-3 border-0 border-t border-solid border-line pt-5"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="account-stats-title" className="text-lg font-bold">
            戦績
          </h2>
          <AppButton
            appearance="quiet"
            size="compact"
            isDisabled={loading || formations.loading}
            isPending={
              pendingSource === "refresh" ||
              (showFormations && formations.pendingSource === "refresh")
            }
            onPress={() => {
              void refresh("refresh");
              void formations.refresh("refresh");
            }}
          >
            更新
          </AppButton>
        </div>
        <p className="text-xs text-muted">対人戦のみ集計</p>
        <div className="flex flex-col gap-3">
          {loading && !pendingSource && (
            <p role="status" className="text-sm text-muted">
              戦績を読み込んでいます…
            </p>
          )}
          {stats && "wins" in stats ? (
            <dl className="m-0 grid grid-cols-2 gap-x-5 gap-y-3">
              <Metric className="col-span-2" label="対局数" value={stats.total} />
              <Metric label="勝数" value={stats.wins} />
              <Metric label="勝率" value={formatStatsRate(stats.wins, stats.total)} />
              <Metric label="敗数" value={stats.losses} />
              <Metric label="敗率" value={formatStatsRate(stats.losses, stats.total)} />
            </dl>
          ) : (
            stats && (
              <dl className="m-0 grid grid-cols-2 gap-x-5 gap-y-3">
                <Metric className="col-span-2" label="対局数" value={stats[mode].total} />
                {mode === "singles" && game === "four-shogi" && "knockouts" in stats.singles && (
                  <>
                    <Metric
                      className="col-span-2"
                      label="完全優勝数"
                      value={stats.singles.perfectWins}
                    />
                    <Metric label="撃破数" value={stats.singles.knockouts} />
                    <Metric
                      label="撃破率"
                      value={formatStatsRate(stats.singles.knockouts, stats.singles.total)}
                    />
                  </>
                )}
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
            )
          )}
          {stats && showFormations && (
            <p className="m-0 text-xs text-muted">撃破率は1局あたりの平均撃破人数です。</p>
          )}
          {error && (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
              <AppButton
                appearance="secondary"
                size="compact"
                isDisabled={loading}
                isPending={pendingSource === "retry"}
                onPress={() => void refresh("retry")}
              >
                再試行
              </AppButton>
            </div>
          )}
        </div>
        {showFormations && (
          <Suspense
            fallback={
              <p role="status" className="text-sm text-muted">
                戦法別戦績を読み込んでいます…
              </p>
            }
          >
            <FormationStats data={formations} />
          </Suspense>
        )}
      </section>
    </>
  );
}
