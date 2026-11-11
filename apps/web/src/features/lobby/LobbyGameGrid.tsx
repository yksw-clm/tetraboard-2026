import { Link } from "react-router";
import { useId, useState, type ReactNode } from "react";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { isRatedMatchmakingGame, ratedMatchmakingRules } from "@tetraboard/protocol";
import { AppButton } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { LobbyBoardPreview } from "./LobbyBoardPreview";
import type { LobbyGameRatingsState } from "./useLobbyGameRatings";

const preferredOrder: readonly GameId[] = [
  "four-shogi",
  "four-reversi",
  "four-gomoku",
  "shogi",
  "reversi",
  "gomoku",
];
const displayOrder = [
  ...preferredOrder,
  ...gameIds.filter((game) => !preferredOrder.includes(game)),
];
const previewCount = 6;

function GameRating({ game, ratings }: { game: GameId; ratings: LobbyGameRatingsState }) {
  if (!isRatedMatchmakingGame(game)) return null;
  if (ratings.error)
    return <span className="text-xs font-normal text-muted">取得できませんでした</span>;
  if (ratings.loading && !ratings.games)
    return <span aria-hidden="true" className="h-4 w-20 rounded bg-surface-muted" />;
  if (!ratings.registered) return null;
  const summary = ratings.games?.[game].summary;
  if (!summary || summary.status === "error")
    return <span className="text-xs font-normal text-muted">取得できませんでした</span>;
  if (summary.status === "rated")
    return (
      <span className="text-sm font-bold tabular-nums">
        <span className="mr-1 text-xs font-normal text-muted">レート</span>
        {summary.rating}
      </span>
    );
  return (
    <span className="text-xs font-normal whitespace-nowrap text-muted tabular-nums">
      {summary.games === 0 ? "認定前" : "認定中"} {summary.games}/
      {ratedMatchmakingRules[game].placementGames}局
    </span>
  );
}

export function HomeGameList({ children, mobile }: { children: ReactNode[]; mobile: boolean }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const canExpand = mobile && children.length > previewCount;
  return (
    <>
      <div
        id={id}
        className="grid grid-cols-6 gap-3 [@media(max-width:767px)]:grid-cols-3 [@media(max-width:767px)]:gap-2"
      >
        {canExpand && !expanded ? children.slice(0, previewCount) : children}
      </div>
      {canExpand && (
        <AppButton
          appearance="secondary"
          className="mt-2 min-h-11 w-full text-sm"
          aria-controls={id}
          aria-expanded={expanded}
          onPress={() => setExpanded((value) => !value)}
        >
          {expanded ? "閉じる" : `残り${children.length - previewCount}ゲームを表示`}
          <AppIcon name="chevronDown" className={expanded ? "rotate-180" : undefined} />
        </AppButton>
      )}
    </>
  );
}

export function LobbyGameGrid({
  create = false,
  mobile = false,
  ratings,
}: {
  create?: boolean;
  mobile?: boolean;
  ratings?: LobbyGameRatingsState;
}) {
  const cards = displayOrder.map((game) => (
    <Link
      key={game}
      to={gameCatalog[game].lobbyPath}
      state={create ? { roomEntryIntent: "create" } : undefined}
      className={`relative flex min-w-0 flex-col items-center justify-start gap-4 rounded-[18px] border border-solid border-line bg-white px-2 py-5 text-center text-sm font-bold text-ink no-underline transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-primary${create ? "" : " [@media(max-width:767px)]:gap-1 [@media(max-width:767px)]:rounded-xl [@media(max-width:767px)]:px-1 [@media(max-width:767px)]:py-2 [@media(max-width:767px)]:text-xs"}${ratings ? " pt-12 [@media(max-width:767px)]:pt-11" : ""}`}
    >
      {ratings && isRatedMatchmakingGame(game) && (
        <span className="absolute top-2 right-2 flex flex-col items-end gap-0.5 leading-tight [@media(max-width:767px)]:top-1.5 [@media(max-width:767px)]:right-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap ${ratings.games?.[game].enabled ? "bg-brand/10 text-brand" : "bg-surface-muted text-muted"}`}
          >
            <AppIcon name="trophy" className="size-3" />
            レート戦
          </span>
          <span className="text-[10px] font-normal text-muted">
            {ratings.games
              ? !ratings.games[game].enabled && "受付停止中"
              : ratings.error
                ? "受付状況不明"
                : "受付確認中"}
          </span>
        </span>
      )}
      <div
        className={`flex h-[70px] items-center justify-center${create ? "" : " [@media(max-width:767px)]:h-8"}`}
      >
        <LobbyBoardPreview
          game={game}
          compact
          className={create ? undefined : "[@media(max-width:767px)]:w-8"}
        />
      </div>
      <div className="flex flex-col items-center gap-1">
        <span
          className={
            ratings
              ? "flex min-h-10 flex-col justify-start [@media(max-width:767px)]:min-h-8"
              : create
                ? undefined
                : "[@media(max-width:767px)]:min-h-8"
          }
        >
          {gameCatalog[game].name}
          {(game === "four-reversi" || game === "reversi") && (
            <span className="block text-xs">（オセロ）</span>
          )}
        </span>
        {ratings && (
          <span className="flex min-h-8 items-start justify-center">
            <GameRating game={game} ratings={ratings} />
          </span>
        )}
      </div>
    </Link>
  ));
  return create ? (
    <div className="grid grid-cols-3 gap-3">{cards}</div>
  ) : (
    <HomeGameList mobile={mobile}>{cards}</HomeGameList>
  );
}
