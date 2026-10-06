import { type RoomMode } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppTabs } from "../../shared/ui/AppTabs";
import { GameSelect } from "../../shared/ui/GameSelect";
import { MatchHistoryCard } from "../matches/MatchHistoryCard";
import { useMatchHistory } from "./useMatchHistory";

export function MatchHistory() {
  const history = useMatchHistory();
  const { page, mode, game } = history;
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
      <GameSelect label="棋譜のゲーム" game={game} onChange={history.setGame} />
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
                  <MatchHistoryCard
                    key={match.id}
                    match={match}
                    to={`/account/matches/${match.id}`}
                  />
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
