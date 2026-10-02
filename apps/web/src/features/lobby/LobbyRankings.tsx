import { useState, type ReactNode } from "react";
import { type RankingEntry, type RoomMode, type MatchGame } from "@tetraboard/protocol";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppTabs } from "../../shared/ui/AppTabs";
import { type AppTheme } from "../../shared/ui/appTheme";
import { useRankings } from "./useRankings";

function ModeTabs({
  mode,
  onChange,
  children,
}: {
  mode: RoomMode;
  onChange: (mode: RoomMode) => void;
  children: ReactNode;
}) {
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

function RankingList({ entries, label }: { entries: RankingEntry[]; label: string }) {
  return entries.length ? (
    <ol aria-label={`${label}ランキング`} className="m-0 flex flex-col gap-3 p-0 list-none">
      {entries.map((entry) => (
        <li key={entry.username} className="flex min-w-0 items-center gap-2 text-sm">
          <span className="w-8 shrink-0 text-muted text-xs tabular-nums">{entry.rank}位</span>
          <AppAvatar src={entry.avatarUrl} label={`${entry.name}のアイコン`} className="size-8" />
          <span className="min-w-0 flex-1 break-words font-semibold">{entry.name}</span>
          <span className="shrink-0 font-semibold tabular-nums">
            {entry.value}
            <span className="ml-1 text-xs font-normal text-muted">
              {label === "対局数" ? "局" : "回"}
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
  total = false,
  limit,
}: {
  state: ReturnType<typeof useRankings>;
  mode: RoomMode;
  total?: boolean;
  limit: number;
}) {
  const label = total ? "対局数" : mode === "singles" ? "優勝数" : "勝利数";
  const entries =
    state.rankings &&
    (total
      ? state.rankings[mode].total
      : mode === "singles"
        ? state.rankings.singles.first
        : state.rankings.doubles.wins);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-muted">{label}</h3>
      {state.loading && (
        <p role="status" className="text-sm text-muted">
          ランキングを読み込んでいます…
        </p>
      )}
      {entries && <RankingList entries={entries.slice(0, limit)} label={label} />}
      {state.error && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
          <AppButton appearance="secondary" size="compact" onPress={() => void state.refresh()}>
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
  onClose,
  theme,
}: {
  state: ReturnType<typeof useRankings>;
  initialMode: RoomMode;
  onClose: () => void;
  theme: AppTheme;
}) {
  const [mode, setMode] = useState(initialMode);
  const [metric, setMetric] = useState("victories");
  return (
    <AppDialog title="ランキング" onClose={onClose} theme={theme}>
      <div className="flex flex-col gap-4">
        <ModeTabs mode={mode} onChange={setMode}>
          <AppTabs selectedKey={metric} onSelectionChange={(key) => setMetric(String(key))}>
            <AppTabs.List aria-label="ランキングの集計項目">
              <AppTabs.Tab id="victories">
                {mode === "singles" ? "優勝数" : "勝利数"}
                <AppTabs.Indicator />
              </AppTabs.Tab>
              <AppTabs.Tab id="total">
                対局数
                <AppTabs.Indicator />
              </AppTabs.Tab>
            </AppTabs.List>
            {(["victories", "total"] as const).map((tab) => (
              <AppTabs.Panel key={tab} id={tab} className="pt-4">
                {tab === metric && (
                  <RankingContent state={state} mode={mode} total={tab === "total"} limit={10} />
                )}
              </AppTabs.Panel>
            ))}
          </AppTabs>
        </ModeTabs>
        <AppButton
          appearance="quiet"
          size="compact"
          isDisabled={state.loading}
          onPress={() => void state.refresh()}
        >
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
  const [mode, setMode] = useState<RoomMode>("singles");
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="lobby-rankings-title" className="min-w-0">
      <AppCard className="h-full gap-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 id="lobby-rankings-title" className="text-lg font-bold">
            ランキング
          </h2>
          <AppButton
            appearance="quiet"
            size="compact"
            aria-label="ランキングを更新"
            isDisabled={state.loading}
            onPress={() => void state.refresh()}
          >
            更新
          </AppButton>
        </div>
        <ModeTabs mode={mode} onChange={setMode}>
          <RankingContent state={state} mode={mode} limit={3} />
        </ModeTabs>
        <AppButton
          appearance="quiet"
          size="compact"
          className="mt-auto self-end"
          onPress={() => setOpen(true)}
        >
          もっと見る
        </AppButton>
      </AppCard>
      {open && (
        <RankingsDialog
          state={state}
          initialMode={mode}
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
