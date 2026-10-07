import type { GameId } from "@tetraboard/protocol";
import { useEffect, useRef, useState } from "react";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { AppButton } from "../../shared/ui/AppButton";
import { MatchHistoryCard } from "./MatchHistoryCard";
import { useRecentMatches } from "./useRecentMatches";

export function RecentMatches({ game }: { game: GameId }) {
  const page = useRecentMatches(game);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const timeout = window.setTimeout(() => setNowMs(Date.now()), 0);
    const interval = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [page.matches]);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (list.current) list.current.scrollLeft = 0;
  }, [page.revision]);
  return (
    <section
      aria-labelledby="recent-matches-title"
      className="min-w-0 [@media(min-width:768px)]:col-span-2"
    >
      <AppSectionHeading
        id="recent-matches-title"
        title="最近行われた対局"
        description="保存済みの棋譜から、対局を振り返れます。"
      >
        <AppButton
          size="compact"
          appearance="quiet"
          isDisabled={page.loading}
          isPending={page.pendingSource === "refresh"}
          onPress={() => void page.refresh("refresh")}
        >
          更新
        </AppButton>
      </AppSectionHeading>
      <label className="mb-2 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={page.humanOnly}
          onChange={(event) => page.changeHumanOnly(event.target.checked)}
        />
        人間4人の対局のみ
      </label>
      {page.loading && !page.pendingSource && (
        <p role="status" className="text-sm text-muted">
          最近の対局を読み込んでいます…
        </p>
      )}
      <ul
        ref={list}
        aria-label="最近行われた対局の棋譜"
        tabIndex={page.matches.length ? 0 : undefined}
        className="m-0 flex w-full min-w-0 flex-nowrap gap-3 overflow-x-auto list-none p-0 pb-1"
      >
        {page.matches.map((match) => (
          <li key={match.id} className="min-w-0 shrink-0 [width:min(320px,100%)]">
            <MatchHistoryCard
              match={match}
              to={`/matches/${match.id}`}
              className="h-full"
              relativeToMs={nowMs}
            />
          </li>
        ))}
      </ul>
      {page.loaded && !page.loading && !page.error && !page.matches.length && (
        <p className="text-sm text-muted">
          {page.humanOnly ? "人間4人の対局履歴がありません。" : "まだ対局履歴がありません。"}
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
            isDisabled={page.loading}
            isPending={page.pendingSource === "retry"}
            onPress={() => void page.refresh("retry")}
          >
            再試行
          </AppButton>
        </div>
      )}
    </section>
  );
}
