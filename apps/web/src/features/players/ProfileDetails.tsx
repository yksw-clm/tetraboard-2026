import { gameCatalog, type GameId } from "@tetraboard/protocol/games";

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
                className="max-w-full rounded-full bg-surface-muted px-2 py-1 text-xs wrap-anywhere"
              >
                {gameCatalog[game].name}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
