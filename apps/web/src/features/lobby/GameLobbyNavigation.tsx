import { NavLink } from "react-router";
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
  return (
    <nav
      aria-label="ゲームを選択"
      className="app-theme border-b border-solid border-[#dfe7e2] bg-[#f9fbfa]"
    >
      <div className={cn(appPageWidthClasses, "py-3")}>
        <div className="grid w-full max-w-[540px] grid-cols-4 gap-2 [@media(max-width:650px)]:max-w-none">
          {games.map((game) => (
            <NavLink
              key={game.path}
              to={game.path}
              end
              className={({ isActive }) =>
                cn(
                  game.theme,
                  "flex min-h-11 items-center justify-center rounded-control px-3 py-2 text-sm font-semibold no-underline",
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
