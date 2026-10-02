import { Avatar } from "@heroui/react";
import {
  type MatchSummary,
  type MatchHistoryParticipant,
  type RoomMode,
} from "@tetraboard/protocol";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppTabs } from "../../shared/ui/AppTabs";
import { useMatchHistory } from "./useMatchHistory";

const colorOrder = ["black", "white", "red", "blue"] as const;
const dateFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function Participant({ player }: { player: MatchHistoryParticipant }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {player.kind === "cpu" ? (
        <Avatar
          className="size-6 shrink-0 rounded-full bg-[#e0edff] text-[#376597]"
          aria-label="CPUアイコン"
        >
          <Avatar.Fallback className="grid size-full place-items-center bg-transparent text-inherit">
            <AppIcon name="robot" className="size-4" />
          </Avatar.Fallback>
        </Avatar>
      ) : (
        <AppAvatar
          src={player.avatarUrl}
          label={`${player.name}のアイコン`}
          className="size-6 [&_svg]:size-4"
        />
      )}
      <span className="min-w-0 text-xs font-semibold leading-4 [overflow-wrap:anywhere]">
        {player.name}
      </span>
    </div>
  );
}
function MatchHistoryCard({ match }: { match: MatchSummary }) {
  const result = match.result;
  const gameLabel = `四人リバーシ・${match.mode === "singles" ? "シングルス" : "ダブルス"}`;
  const teamColors = { "black-red": ["black", "red"], "white-blue": ["white", "blue"] } as const;
  const teams =
    result.mode === "doubles" && result.winner === "white-blue"
      ? (["white-blue", "black-red"] as const)
      : (["black-red", "white-blue"] as const);
  return (
    <article
      aria-label={`${dateFormat.format(match.startedAtMs)} ${gameLabel}の対局`}
      className="flex flex-col gap-3 rounded-control border border-solid border-line bg-white p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <time dateTime={new Date(match.startedAtMs).toISOString()}>
          {dateFormat.format(match.startedAtMs)}
        </time>
        <span>{gameLabel}</span>
      </div>
      {result.mode === "singles" ? (
        <ol className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-2 p-0">
          {[...result.standings]
            .sort(
              (a, b) =>
                a.rank - b.rank || colorOrder.indexOf(a.color) - colorOrder.indexOf(b.color),
            )
            .map((standing) => {
              const player = match.participants.find((p) => p.color === standing.color)!;
              return (
                <li key={player.id} className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`w-7 shrink-0 text-xs font-bold ${standing.rank === 1 ? "text-brand" : "text-muted"}`}
                  >
                    {standing.rank === 1 ? "優勝" : `${standing.rank}位`}
                  </span>
                  <Participant player={player} />
                </li>
              );
            })}
        </ol>
      ) : (
        <div className="flex flex-col gap-2">
          {teams.map((team) => (
            <div
              key={team}
              className="grid grid-cols-[48px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1.5"
            >
              <span
                className={`text-xs font-bold ${result.winner === team ? "text-brand" : "text-muted"}`}
              >
                {result.winner === null ? "引き分け" : result.winner === team ? "勝利" : "敗北"}
              </span>
              {teamColors[team].map((color) => (
                <Participant
                  key={color}
                  player={match.participants.find((p) => p.color === color)!}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-muted">準備中</span>
        <AppButton size="compact" appearance="secondary" isDisabled>
          棋譜を見る
        </AppButton>
      </div>
    </article>
  );
}
export function MatchHistory() {
  const history = useMatchHistory();
  const { page, mode } = history;
  return (
    <AppCard data-testid="account-replay-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">棋譜</h2>
        <AppButton
          appearance="quiet"
          size="compact"
          isDisabled={page.loading || page.moreLoading || !page.loaded}
          onPress={() => void history.refresh()}
        >
          更新
        </AppButton>
      </div>
      <AppTabs selectedKey={mode} onSelectionChange={(key) => history.setMode(key as RoomMode)}>
        <AppTabs.List aria-label="棋譜の対局モード">
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
                {(!page.loaded || page.loading) && (
                  <p role="status" className="text-sm text-muted">
                    対局履歴を読み込んでいます…
                  </p>
                )}
                {page.matches.map((match) => (
                  <MatchHistoryCard key={match.id} match={match} />
                ))}
                {page.loaded && !page.loading && !page.error && page.matches.length === 0 && (
                  <p className="text-sm text-muted">まだ対局履歴がありません。</p>
                )}
                {page.error && (
                  <div className="flex flex-col items-start gap-2">
                    <p role="alert" className="text-sm text-danger">
                      {page.error}
                    </p>
                    <AppButton
                      size="compact"
                      appearance="secondary"
                      onPress={() => void history.retry()}
                    >
                      再試行
                    </AppButton>
                  </div>
                )}
                {page.nextCursor && !page.error && (
                  <AppButton
                    size="compact"
                    appearance="secondary"
                    isDisabled={page.loading || page.moreLoading}
                    onPress={() => void history.loadMore()}
                  >
                    {page.moreLoading ? "読み込んでいます…" : "もっと見る"}
                  </AppButton>
                )}
              </div>
            )}
          </AppTabs.Panel>
        ))}
      </AppTabs>
    </AppCard>
  );
}
