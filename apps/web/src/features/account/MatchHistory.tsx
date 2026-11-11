import {
  isRatedMatchmakingGame,
  type MatchGame,
  type RoomMode,
  type MatchHistoryFilter,
} from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppTabs } from "../../shared/ui/AppTabs";
import { useId } from "react";
import { MatchHistoryCard } from "../matches/MatchHistoryCard";
import { useMatchHistory } from "./useMatchHistory";
import { useMatchHistoryFilter } from "./useMatchHistoryFilter";

export function MatchHistory({ game, mode }: { game: MatchGame; mode: RoomMode }) {
  const { filter, setFilter } = useMatchHistoryFilter();
  const history = useMatchHistory(game, mode, filter);
  const { page } = history;
  const panelId = useId();
  const unsupportedRated =
    filter === "rated" && (!isRatedMatchmakingGame(game) || mode === "doubles");
  return (
    <AppCard data-testid="account-replay-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">棋譜</h2>
        <AppButton
          appearance="quiet"
          size="compact"
          isDisabled={page.loading || page.moreLoading || !page.loaded}
          isPending={page.pendingSource === "refresh"}
          onPress={() => void history.refresh()}
        >
          更新
        </AppButton>
      </div>
      <AppTabs
        selectedKey={filter}
        onSelectionChange={(key) => setFilter(key as MatchHistoryFilter)}
        className="flex flex-col gap-3"
      >
        <div>
          <AppTabs.List aria-label="棋譜の絞り込み">
            {(
              [
                ["all", "すべて"],
                ["rated", "レート戦"],
                ["human", "対人戦"],
                ["cpu", "CPU戦"],
              ] as const
            ).map(([value, label]) => (
              <AppTabs.Tab
                key={value}
                id={value}
                className="min-w-0 whitespace-nowrap px-0 text-xs sm:px-3 sm:text-[13px]"
                render={(props) =>
                  "href" in props ? (
                    <a {...props} aria-controls={props["aria-selected"] ? panelId : undefined} />
                  ) : (
                    <div {...props} aria-controls={props["aria-selected"] ? panelId : undefined} />
                  )
                }
              >
                {label}
                <AppTabs.Indicator />
              </AppTabs.Tab>
            ))}
          </AppTabs.List>
          <p className="mt-2 mb-0 text-xs text-muted">レート戦にはCPU補充局を含みます。</p>
        </div>
        <AppTabs.Panel
          id={filter}
          className="flex flex-col gap-3 p-0"
          render={(props) => <div {...props} id={panelId} />}
        >
          {(!page.loaded || page.loading) && !page.pendingSource && (
            <p role="status" className="text-sm text-muted">
              対局履歴を読み込んでいます…
            </p>
          )}
          {page.matches.map((match) => (
            <MatchHistoryCard key={match.id} match={match} to={`/account/matches/${match.id}`} />
          ))}
          {page.loaded && !page.loading && !page.error && page.matches.length === 0 && (
            <p className="text-sm text-muted">
              {unsupportedRated
                ? "このゲーム・モードにはレート戦がありません。"
                : filter === "all"
                  ? "まだ対局履歴がありません。"
                  : "この条件に一致する棋譜はありません。"}
            </p>
          )}
          {page.error && (
            <div className="flex flex-col items-start gap-2">
              <p role="alert" className="text-sm text-danger">
                {page.error}
              </p>
              <AppButton
                size="compact"
                appearance="secondary"
                isDisabled={page.loading || page.moreLoading}
                isPending={page.pendingSource === "retry"}
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
              isPending={page.pendingSource === "more"}
              onPress={() => void history.loadMore()}
            >
              もっと見る
            </AppButton>
          )}
        </AppTabs.Panel>
      </AppTabs>
    </AppCard>
  );
}
