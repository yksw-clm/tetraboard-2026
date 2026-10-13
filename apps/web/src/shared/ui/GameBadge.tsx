import { cn } from "@heroui/react";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { Link } from "react-router";
import { appThemeClasses, gameThemes } from "./appTheme";

export function GameBadge({ game, link = false }: { game: GameId; link?: boolean }) {
  const className = cn(
    appThemeClasses[gameThemes[game]],
    "inline-flex shrink-0 rounded-control bg-surface-muted px-2 py-1 text-xs font-semibold text-brand",
  );
  return link ? (
    <Link
      to={gameCatalog[game].lobbyPath}
      className={cn(className, "no-underline hover:underline")}
    >
      {gameCatalog[game].name}
    </Link>
  ) : (
    <span className={className}>{gameCatalog[game].name}</span>
  );
}
