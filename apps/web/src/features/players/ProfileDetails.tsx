import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { cn } from "@heroui/react";
import { LobbyBoardPreview } from "../lobby/LobbyBoardPreview";
import { gameAccentClasses } from "../../shared/ui/appTheme";

export function ProfileDetails({
  profileMessage,
  favoriteGames,
}: {
  profileMessage?: string;
  favoriteGames?: readonly GameId[];
}) {
  return (
    <>
      {profileMessage && (
        <div
          aria-label="ひとこと"
          className="relative rounded-control border border-solid border-line bg-surface-muted p-3 text-sm leading-relaxed"
        >
          <span
            aria-hidden="true"
            className="absolute -top-[7px] left-[18px] size-3 rotate-45 border-0 border-t border-l border-solid border-line bg-surface-muted"
          />
          <p className="relative m-0 wrap-anywhere">{profileMessage}</p>
        </div>
      )}
      {favoriteGames && favoriteGames.length > 0 && (
        <section aria-label="お気に入りゲーム" className="flex min-w-0 flex-col gap-2">
          <p className="m-0 text-xs text-muted">お気に入りゲーム</p>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {favoriteGames.map((game) => (
              <li
                key={game}
                className={cn(
                  gameAccentClasses[game],
                  "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--game-accent)_8%,white)] px-2 py-1 text-xs font-semibold text-[var(--game-accent)]",
                )}
              >
                <LobbyBoardPreview game={game} compact className="!w-5 !rotate-0 !shadow-none" />
                <span className="min-w-0 wrap-anywhere">{gameCatalog[game].name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
