import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router";
import { cn } from "@heroui/react";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";

const games = gameIds.map((id) => ({
  path: gameCatalog[id].lobbyPath,
  title: gameCatalog[id].name,
  theme: appThemeClasses[gameThemes[id]],
}));

export function GameLobbyNavigation() {
  const navigation = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    navigation.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  return (
    <nav
      aria-label="ゲームを選択"
      className="app-theme border-b border-solid border-[#dfe7e2] bg-[#f9fbfa]"
    >
      <div className={cn(appPageWidthClasses, "py-2")}>
        <div ref={navigation} className="flex w-full gap-2 overflow-x-auto py-1 px-1">
          {games.map((game) => (
            <NavLink
              key={game.path}
              to={game.path}
              end
              className={({ isActive }) =>
                cn(
                  game.theme,
                  "flex min-h-11 shrink-0 items-center justify-center rounded-control px-3 py-2 text-sm font-semibold no-underline",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-action"
                    : "text-[#65736c] hover:bg-[#e7eeea]",
                )
              }
            >
              {game.title}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}
