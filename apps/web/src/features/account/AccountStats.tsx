import { gameCatalog } from "@tetraboard/protocol/games";
import { lazy, Suspense } from "react";
import { type MatchGame, type RoomMode } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { formatStatsRate } from "./statsPresentation";
import { StatsTable, type StatsRow } from "./StatsTable";
import { useFormationStats } from "./useFormationStats";
import { useAccountStats } from "./useAccountStats";
import { AccountBadges } from "../badges/AccountBadges";
const FormationStats = lazy(() => import("./FormationStats"));

export function AccountStats({ game, mode }: { game: MatchGame; mode: RoomMode }) {
  const { stats, loading, error, pendingSource, refresh } = useAccountStats(game);
  const showFormations = game === "four-shogi" && mode === "singles";
  const formations = useFormationStats(showFormations);
  const rows: StatsRow[] = [];
  if (stats) {
    const selected = "wins" in stats ? stats : stats[mode];
    const shogiSingles =
      showFormations && "singles" in stats && "knockouts" in stats.singles ? stats.singles : null;
    rows.push([
      { label: "対局数", value: selected.total },
      shogiSingles ? { label: "完全優勝数", value: shogiSingles.perfectWins } : undefined,
    ]);
    const counts =
      "wins" in selected
        ? [
            { label: "勝", count: selected.wins },
            { label: "敗", count: selected.losses },
          ]
        : [
            { label: "優勝", count: selected.first },
            { label: "2位", count: selected.second },
            { label: "3位", count: selected.third },
            { label: "4位", count: selected.fourth },
          ];
    if (shogiSingles) counts.unshift({ label: "撃破", count: shogiSingles.knockouts });
    for (const { label, count } of counts)
      rows.push([
        { label: `${label}数`, value: count },
        { label: `${label}率`, value: formatStatsRate(count, selected.total) },
      ]);
  }
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
          {stats && <StatsTable rows={rows} label="戦績" />}
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
