import { gameCatalog } from "@tetraboard/protocol/games";
import { gameThemes } from "../../shared/ui/appTheme";
import { PlayerProfileTrigger } from "../players/PlayerProfileTrigger";
import { useState, type ReactNode } from "react";
import { type PreviewRankings, type RoomMode, type MatchGame } from "@tetraboard/protocol";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppTabs } from "../../shared/ui/AppTabs";
import { type AppTheme } from "../../shared/ui/appTheme";
import { useRankings } from "./useRankings";

type RankingMetric = "victories" | "total" | "knockouts";
const normalMetrics: RankingMetric[] = ["victories", "total"];
const shogiSinglesMetrics: RankingMetric[] = ["victories", "total", "knockouts"];

function rankingMetrics(game: MatchGame, mode: RoomMode) {
  return game === "four-shogi" && mode === "singles" ? shogiSinglesMetrics : normalMetrics;
}

function rankingLabel(game: MatchGame, mode: RoomMode, metric: RankingMetric) {
  if (metric === "total") return "対局数";
  if (metric === "knockouts") return "撃破数";
  return gameCatalog[game].hasModes && mode === "singles" ? "優勝数" : "勝利数";
}

function ModeTabs({
  mode,
  onChange,
  children,
  withoutModes = false,
}: {
  withoutModes?: boolean;
  mode: RoomMode;
  onChange: (mode: RoomMode) => void;
  children: ReactNode;
}) {
  if (withoutModes) return <>{children}</>;
  return (
    <AppTabs selectedKey={mode} onSelectionChange={(key) => onChange(key as RoomMode)}>
      <AppTabs.List aria-label="ランキングの対局モード">
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
          {tab === mode && children}
        </AppTabs.Panel>
      ))}
    </AppTabs>
  );
}

function RankingList({
  entries,
  label,
  game,
  mode,
}: {
  entries: PreviewRankings["singles"]["first"];
  label: string;
  game: MatchGame;
  mode: RoomMode;
}) {
  return entries.length ? (
    <ol aria-label={`${label}ランキング`} className="m-0 flex flex-col gap-3 p-0 list-none">
      {entries.map((entry) => (
        <li
          key={entry.profileId ?? entry.username ?? `${entry.rank}:${entry.name}`}
          className="flex min-w-0 items-center gap-2 border-b border-solid border-line py-3 text-sm last:border-0"
        >
          <span className="w-8 shrink-0 text-muted text-xs tabular-nums">{entry.rank}位</span>
          <PlayerProfileTrigger
            target={entry.profileId ? { source: "profile", profileId: entry.profileId } : undefined}
            game={game}
            mode={mode}
            theme={gameThemes[game]}
            label={entry.name}
          >
            <AppAvatar src={entry.avatarUrl} label={`${entry.name}のアイコン`} className="size-8" />
          </PlayerProfileTrigger>
          <span className="min-w-0 flex-1 break-words font-semibold">
            <PlayerProfileTrigger
              target={
                entry.profileId ? { source: "profile", profileId: entry.profileId } : undefined
              }
              game={game}
              mode={mode}
              theme={gameThemes[game]}
              label={entry.name}
            >
              {entry.name}
              {entry.isGuest && <span className="ml-1 text-xs font-normal text-muted">ゲスト</span>}
            </PlayerProfileTrigger>
          </span>
          <span className="shrink-0 font-semibold tabular-nums">
            {entry.value}
            <span className="ml-1 text-xs font-normal text-muted">
              {label === "対局数" ? "局" : label === "撃破数" ? "人" : "回"}
            </span>
          </span>
        </li>
      ))}
    </ol>
  ) : (
    <p className="text-sm text-muted">まだランキングの対象者がいません。</p>
  );
}

function RankingContent({
  state,
  mode,
  metric = "victories",
  limit,
  source = "retry",
}: {
  state: ReturnType<typeof useRankings>;
  mode: RoomMode;
  metric?: RankingMetric;
  limit: number;
  source?: string;
}) {
  const label = rankingLabel(state.game, mode, metric);
  const entries =
    state.rankings &&
    (metric === "knockouts"
      ? "singles" in state.rankings
        ? state.rankings.singles.knockouts
        : undefined
      : "wins" in state.rankings
        ? metric === "total"
          ? state.rankings.total
          : state.rankings.wins
        : metric === "total"
          ? state.rankings[mode].total
          : mode === "singles"
            ? state.rankings.singles.first
            : state.rankings.doubles.wins);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-muted">{label}</h3>
      {state.loading && !state.pendingSource && (
        <p role="status" className="text-sm text-muted">
          ランキングを読み込んでいます…
        </p>
      )}
      {entries && (
        <RankingList
          entries={entries.slice(0, limit)}
          label={label}
          game={state.game}
          mode={mode}
        />
      )}
      {metric === "knockouts" && state.rankings && !entries && !state.loading && (
        <p className="text-sm text-muted">撃破数ランキングは現在表示できません。</p>
      )}
      {state.error && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
          <AppButton
            appearance="secondary"
            size="compact"
            isDisabled={state.loading}
            isPending={state.pendingSource === source}
            onPress={() => void state.refresh(source)}
          >
            再試行
          </AppButton>
        </div>
      )}
    </div>
  );
}

function RankingsDialog({
  state,
  initialMode,
  initialMetric,
  onClose,
  theme,
}: {
  state: ReturnType<typeof useRankings>;
  initialMode: RoomMode;
  initialMetric: RankingMetric;
  onClose: () => void;
  theme: AppTheme;
}) {
  const [mode, setMode] = useState(initialMode);
  const [metric, setMetric] = useState<RankingMetric>(initialMetric);
  const metrics = rankingMetrics(state.game, mode);
  return (
    <AppDialog title="ランキング" onClose={onClose} theme={theme}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted">対人戦のみ集計</p>
        <p className="text-xs text-muted">
          CPUを含まない対局で、アカウントで参加したユーザーの成績を集計します。対戦相手にゲストがいても対象です。
        </p>
        <ModeTabs
          withoutModes={!gameCatalog[state.game].hasModes}
          mode={mode}
          onChange={(next) => {
            setMode(next);
            setMetric("victories");
          }}
        >
          <AppTabs
            selectedKey={metric}
            onSelectionChange={(key) => setMetric(key as RankingMetric)}
          >
            <AppTabs.List aria-label="ランキングの集計項目">
              {metrics.map((tab) => (
                <AppTabs.Tab key={tab} id={tab}>
                  {rankingLabel(state.game, mode, tab)}
                  <AppTabs.Indicator />
                </AppTabs.Tab>
              ))}
            </AppTabs.List>
            {metrics.map((tab) => (
              <AppTabs.Panel key={tab} id={tab} className="pt-4">
                {tab === metric && (
                  <RankingContent
                    state={state}
                    mode={mode}
                    metric={tab}
                    limit={10}
                    source="dialog-retry"
                  />
                )}
              </AppTabs.Panel>
            ))}
          </AppTabs>
        </ModeTabs>
        <AppButton
          appearance="quiet"
          size="compact"
          isDisabled={state.loading}
          isPending={state.pendingSource === "dialog-refresh"}
          onPress={() => void state.refresh("dialog-refresh")}
        >
          <AppIcon name="refresh" />
          更新
        </AppButton>
      </div>
    </AppDialog>
  );
}

function LobbyRankingsView({
  state,
  theme,
}: {
  state: ReturnType<typeof useRankings>;
  theme: AppTheme;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="lobby-rankings-title" className="min-w-0">
      <AppCard className="gap-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="lobby-rankings-title"
            className="inline-flex items-center gap-2 text-lg font-bold"
          >
            <AppIcon name="trophy" />
            ランキング
          </h2>
          <AppButton
            appearance="quiet"
            size="compact"
            className="px-0 text-xs"
            onPress={() => setOpen(true)}
          >
            もっと見る
          </AppButton>
        </div>
        <p className="text-xs text-muted">
          {gameCatalog[state.game].hasModes ? "シングルス・優勝数" : "勝利数"}（対人戦のみ集計）
        </p>
        <div className="[&_h3]:sr-only">
          <RankingContent state={state} mode="singles" limit={3} />
        </div>
      </AppCard>
      {open && (
        <RankingsDialog
          state={state}
          initialMode="singles"
          initialMetric="victories"
          onClose={() => setOpen(false)}
          theme={theme}
        />
      )}
    </section>
  );
}

function AvailableLobbyRankings({ theme, game }: { theme: AppTheme; game: MatchGame }) {
  const state = useRankings(game);
  return <LobbyRankingsView state={state} theme={theme} />;
}

export function LobbyRankings({
  game = "four-reversi",
  theme = "default",
}: {
  game?: MatchGame;
  theme?: AppTheme;
}) {
  return <AvailableLobbyRankings key={game} theme={theme} game={game} />;
}
