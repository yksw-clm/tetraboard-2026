import { defaultGameId, gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { LobbyBoardPreview } from "../features/lobby/LobbyBoardPreview";
import { AppIcon } from "../shared/ui/AppIcon";

export function InitialNavigation({
  game = defaultGameId,
  current,
  boardSrc,
}: {
  game?: GameId;
  current?: "home" | "lobby" | "how-to-play";
  boardSrc?: string;
}) {
  return (
    <header className="border-b border-solid border-line bg-[#f9fbfa]">
      <div className="mx-auto flex max-w-[1148px] flex-wrap items-center gap-5 px-5 py-3">
        <a
          href="/"
          className="inline-flex items-center gap-3 text-2xl font-bold text-ink no-underline"
        >
          <img src="/favicon.ico" width="32" height="32" alt="" />
          TetraBoard
        </a>
        <nav
          aria-label="メインナビゲーション"
          className="flex items-center gap-5 text-sm font-bold"
        >
          <a
            href="/"
            aria-current={current === "home" ? "page" : undefined}
            className="inline-flex min-h-11 items-center gap-2 text-brand no-underline"
          >
            <AppIcon name="home" />
            ホーム
          </a>
          <a
            href="/how-to-play"
            aria-current={current === "how-to-play" ? "page" : undefined}
            className={`inline-flex min-h-11 items-center gap-2 ${current === "how-to-play" ? "text-brand" : "text-muted"} no-underline`}
          >
            <AppIcon name="book" />
            遊び方
          </a>
          <a
            href={gameCatalog[game].lobbyPath}
            aria-current={current === "lobby" ? "page" : undefined}
            className="inline-flex min-h-11 items-center gap-2 text-brand no-underline"
          >
            <span className="grid size-6 place-items-center [&_img]:w-5 [&_img]:max-h-6 [&_img]:object-contain [&_img]:rotate-0 [&_img]:shadow-none">
              <LobbyBoardPreview game={game} src={boardSrc} compact />
            </span>
            {gameCatalog[game].name}
          </a>
        </nav>
      </div>
    </header>
  );
}
