import { Link } from "react-router";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { LobbyBoardPreview } from "./LobbyBoardPreview";

const displayOrder = [
  "four-shogi",
  "four-reversi",
  "four-gomoku",
  "shogi",
  "reversi",
  "gomoku",
] as const satisfies readonly GameId[];
export function LobbyGameGrid({ create = false }: { create?: boolean }) {
  return (
    <div
      className={`grid gap-3 ${create ? "grid-cols-3" : "grid-cols-6 [@media(max-width:767px)]:grid-cols-3"}`}
    >
      {displayOrder.map((game) => (
        <Link
          key={game}
          to={gameCatalog[game].lobbyPath}
          state={create ? { roomEntryIntent: "create" } : undefined}
          className="flex min-w-0 flex-col items-center justify-start gap-4 rounded-[18px] border border-solid border-line bg-white px-2 py-5 text-center text-sm font-bold text-ink no-underline transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-primary"
        >
          <div className="flex h-[70px] items-center justify-center">
            <LobbyBoardPreview game={game} compact />
          </div>
          <span>
            {gameCatalog[game].name}
            {(game === "four-reversi" || game === "reversi") && (
              <span className="block text-xs">（オセロ）</span>
            )}
          </span>
        </Link>
      ))}
    </div>
  );
}
