import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { cn } from "@heroui/react";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";

const games = gameIds.map((id) => ({
  id,
  path: gameCatalog[id].lobbyPath,
  title: gameCatalog[id].name,
  theme: appThemeClasses[gameThemes[id]],
}));
const links = [{ id: null, path: "/", title: "総合ロビー", theme: "" }, ...games];

export function GameLobbyNavigation({ previews }: { previews?: Record<GameId, ReactNode> } = {}) {
  const navigation = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    navigation.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  const home = links.find((game) => game.id === null);

  function renderLink(game: (typeof links)[number]) {
    return (
      <NavLink
        key={game.path}
        to={game.path}
        end
        className={({ isActive }) =>
          cn(
            game.theme,
            "flex min-h-11 w-[124px] shrink-0 items-center justify-center rounded-control px-3 py-2 text-sm font-semibold no-underline [@media(max-width:767px)]:w-[104px] [@media(max-width:767px)]:text-xs",
            previews && "min-h-[128px] flex-col gap-2 py-3",
            isActive
              ? "bg-primary text-primary-foreground shadow-action"
              : "text-[#65736c] hover:bg-[#e7eeea]",
          )
        }
      >
        {previews && (
          <span
            aria-hidden="true"
            className="pointer-events-none grid h-[72px] w-20 shrink-0 place-items-center"
          >
            {game.id === null ? (
              <span className="grid size-16 place-items-center rounded-control border border-solid border-line bg-white shadow-panel">
                <img src="/favicon.ico" width="48" height="48" alt="" />
              </span>
            ) : (
              previews[game.id]
            )}
          </span>
        )}
        {game.title}
      </NavLink>
    );
  }
  return (
    <nav
      aria-label="ゲームを選択"
      className="app-theme border-b border-solid border-[#dfe7e2] bg-[#f9fbfa]"
    >
      <div className={cn(appPageWidthClasses, "py-2")}>
        <div ref={navigation} className="flex w-full items-end gap-2 overflow-x-auto py-1 px-1">
          {home && (
            <Fragment>
              {renderLink(home)}
              <span
                aria-hidden="true"
                className="mx-1 my-1 shrink-0 self-stretch border-l border-solid border-line"
              />
            </Fragment>
          )}
          <div className="flex min-w-max flex-col gap-2">
            {previews && <p className="text-xs font-semibold text-muted">ゲーム一覧</p>}
            <div className="flex gap-2">{games.map(renderLink)}</div>
          </div>
        </div>
      </div>
    </nav>
  );
}
