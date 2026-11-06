import type { GameId, MatchSummary } from "@tetraboard/protocol";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { gameThemes } from "../../shared/ui/appTheme";
import { PlayerAvatar } from "../room/PlayerAvatar";
import { matchResultGroups } from "../account/matchSummaryPresentation";
import { formatMatchDate } from "./matchDatePresentation";
import { AppSectionHeading } from "../../shared/ui/AppSectionHeading";
import { AppHorizontalScrollButtons } from "../../shared/ui/AppHorizontalScrollButtons";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppButton } from "../../shared/ui/AppButton";
import { AppSkeleton, AppSkeletonCard } from "../../shared/ui/AppSkeleton";
import { MatchHistoryCard } from "./MatchHistoryCard";
import { useRecentMatches } from "./useRecentMatches";

function RecentMatchList({ game }: { game: GameId | "all" }) {
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
          <AppIcon name="refresh" />
          更新
        </AppButton>
      </AppSectionHeading>
      <label className="mb-2 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={page.humanOnly}
          onChange={(event) => page.changeHumanOnly(event.target.checked)}
        />
        対人戦のみ
      </label>
      {page.isInitialLoading && (
        <div className="flex gap-3 overflow-hidden pb-1">
          <AppSkeletonCard className="h-40 shrink-0 [width:min(320px,100%)]" />
          <AppSkeletonCard className="h-40 shrink-0 [width:min(320px,100%)]" />
        </div>
      )}
      <div className="relative isolate min-w-0">
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
                showGame={game === "all"}
              />
            </li>
          ))}
        </ul>
        <AppHorizontalScrollButtons scrollRef={list} label="最近の対局" contentKey={page.matches} />
      </div>
      <RecentMatchStatus page={page} hideLoadingText={page.isInitialLoading} />
    </section>
  );
}

const matchPreviewRowHeight = "h-18 [@media(max-width:767px)]:h-15";

function MatchPreview({ match, nowMs }: { match: MatchSummary; nowMs: number }) {
  const winners = matchResultGroups(match).filter((group) => group.emphasized);
  const first = winners[0]?.players[0];
  const name = winners.flatMap((group) => group.players.map((player) => player.name)).join("・");
  const label = winners[0]?.label === "優勝" ? "優勝" : "勝利";
  return (
    <Link
      to={`/matches/${match.id}`}
      className={`flex min-w-0 items-center gap-3 text-ink no-underline hover:bg-surface-muted ${matchPreviewRowHeight}`}
    >
      <PlayerAvatar
        appearance={
          first?.kind === "cpu"
            ? { kind: "cpu", level: first.level }
            : { kind: "human", avatarUrl: first?.avatarUrl ?? null }
        }
        className="size-8 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm">
          {winners.length ? `${name}が${label}` : "引き分け"}
        </strong>
        <span className="block truncate text-xs text-muted">
          {match.mode ? `${match.mode === "singles" ? "シングルス" : "ダブルス"}・` : ""}
          <time
            dateTime={new Date(match.startedAtMs).toISOString()}
            title={formatMatchDate(match.startedAtMs)}
          >
            {formatMatchDate(match.startedAtMs, nowMs)}
          </time>
        </span>
        <span className="block truncate text-xs text-muted">
          {match.participants.map((player) => player.name).join("・")}
        </span>
      </span>
      <AppIcon name="arrow" className="size-4 shrink-0 text-muted" />
    </Link>
  );
}
function RecentMatchStatus({
  page,
  hideLoadingText = false,
}: {
  page: ReturnType<typeof useRecentMatches>;
  hideLoadingText?: boolean;
}) {
  return (
    <>
      {page.loading && !page.pendingSource && (
        <p role="status" className={hideLoadingText ? "sr-only" : "text-sm text-muted"}>
          最近の対局を読み込んでいます…
        </p>
      )}
      {page.loaded && !page.loading && !page.error && !page.matches.length && (
        <p className="text-sm text-muted">
          {page.humanOnly ? "対人戦の対局履歴がありません。" : "まだ対局履歴がありません。"}
        </p>
      )}
      {page.error && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-danger">
            {page.error}
          </p>
          <AppButton
            appearance="secondary"
            size="compact"
            isDisabled={page.loading}
            isPending={page.pendingSource === "retry"}
            onPress={() => void page.refresh("retry")}
          >
            再試行
          </AppButton>
        </div>
      )}
    </>
  );
}

function GameRecentMatches({ game }: { game: GameId }) {
  const page = useRecentMatches(game);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const status = <RecentMatchStatus page={page} hideLoadingText={page.isInitialLoading} />;
  return (
    <section aria-labelledby="recent-matches-title" className="min-w-0">
      <AppCard className="gap-3 p-5 [@media(max-width:767px)]:gap-2 [@media(max-width:767px)]:p-3">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="recent-matches-title"
            className="inline-flex items-center gap-2 text-lg font-bold"
          >
            <AppIcon name="clock" />
            最近の対局
          </h2>
          <AppButton
            appearance="quiet"
            size="compact"
            className="px-0 text-xs"
            aria-haspopup="dialog"
            aria-expanded={open}
            onPress={() => setOpen(true)}
          >
            もっと見る
          </AppButton>
        </div>
        <div className="min-h-54 [@media(max-width:767px)]:min-h-45">
          {page.isInitialLoading &&
            [0, 1, 2].map((row) => (
              <div
                key={row}
                className={`flex items-center gap-3 ${matchPreviewRowHeight}`}
                aria-hidden="true"
              >
                <AppSkeleton className="size-8 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <AppSkeleton className="h-3 w-1/2" />
                  <AppSkeleton className="h-2 w-1/3" />
                  <AppSkeleton className="h-2 w-2/3" />
                </div>
              </div>
            ))}
          <ul aria-label="最近行われた対局の棋譜" className="m-0 list-none p-0">
            {page.matches.slice(0, 3).map((match) => (
              <li key={match.id}>
                <MatchPreview match={match} nowMs={nowMs} />
              </li>
            ))}
          </ul>
          {!page.matches.length && status}
        </div>
        {page.matches.length > 0 && status}
      </AppCard>
      {open && (
        <AppDialog title="最近の対局" theme={gameThemes[game]} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex min-h-11 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={page.humanOnly}
                  onChange={(event) => page.changeHumanOnly(event.currentTarget.checked)}
                />
                対人戦のみ
              </label>
              <AppButton
                appearance="quiet"
                size="compact"
                isDisabled={page.loading}
                isPending={page.pendingSource === "refresh"}
                onPress={() => void page.refresh("refresh")}
              >
                <AppIcon name="refresh" />
                更新
              </AppButton>
            </div>
            <ul
              aria-label="最近行われた対局の詳細一覧"
              className="m-0 flex list-none flex-col gap-3 p-0"
            >
              {page.matches.map((match) => (
                <li key={match.id}>
                  <MatchHistoryCard
                    match={match}
                    to={`/matches/${match.id}`}
                    showGame={false}
                    relativeToMs={nowMs}
                  />
                </li>
              ))}
            </ul>
            <RecentMatchStatus page={page} />
          </div>
        </AppDialog>
      )}
    </section>
  );
}
export function RecentMatches({ game }: { game: GameId | "all" }) {
  return game === "all" ? (
    <RecentMatchList game={game} />
  ) : (
    <GameRecentMatches key={game} game={game} />
  );
}
