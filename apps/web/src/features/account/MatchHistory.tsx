import { type MatchGame, type RoomMode } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { MatchHistoryCard } from "../matches/MatchHistoryCard";
import { useMatchHistory } from "./useMatchHistory";

export function MatchHistory({ game, mode }: { game: MatchGame; mode: RoomMode }) {
  const history = useMatchHistory(game, mode);
  const { page } = history;
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
      <div className="flex flex-col gap-3">
        {(!page.loaded || page.loading) && !page.pendingSource && (
          <p role="status" className="text-sm text-muted">
            対局履歴を読み込んでいます…
          </p>
        )}
        {page.matches.map((match) => (
          <MatchHistoryCard key={match.id} match={match} to={`/account/matches/${match.id}`} />
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
      </div>
    </AppCard>
  );
}
