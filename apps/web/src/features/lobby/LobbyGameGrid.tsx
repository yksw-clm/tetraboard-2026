import { Link } from "react-router";
import { useId, useState, type ReactNode } from "react";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { AppButton } from "../../shared/ui/AppButton";
import { AppIcon } from "../../shared/ui/AppIcon";
import { LobbyBoardPreview } from "./LobbyBoardPreview";

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
}: {
  create?: boolean;
  mobile?: boolean;
}) {
  const cards = displayOrder.map((game) => (
    <Link
      key={game}
      to={gameCatalog[game].lobbyPath}
      state={create ? { roomEntryIntent: "create" } : undefined}
      className={`flex min-w-0 flex-col items-center justify-start gap-4 rounded-[18px] border border-solid border-line bg-white px-2 py-5 text-center text-sm font-bold text-ink no-underline transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-primary${create ? "" : " [@media(max-width:767px)]:gap-1 [@media(max-width:767px)]:rounded-xl [@media(max-width:767px)]:px-1 [@media(max-width:767px)]:py-2 [@media(max-width:767px)]:text-xs"}`}
    >
      <div
        className={`flex h-[70px] items-center justify-center${create ? "" : " [@media(max-width:767px)]:h-8"}`}
      >
        <LobbyBoardPreview
          game={game}
          compact
          className={create ? undefined : "[@media(max-width:767px)]:w-8"}
        />
      </div>
      <span className={create ? undefined : "[@media(max-width:767px)]:min-h-8"}>
        {gameCatalog[game].name}
        {(game === "four-reversi" || game === "reversi") && (
          <span className="block text-xs">（オセロ）</span>
        )}
      </span>
    </Link>
  ));
  return create ? (
    <div className="grid grid-cols-3 gap-3">{cards}</div>
  ) : (
    <HomeGameList mobile={mobile}>{cards}</HomeGameList>
  );
}
