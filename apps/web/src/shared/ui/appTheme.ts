import type { GameId } from "@tetraboard/protocol/games";

export type AppTheme = "default" | "four-shogi";

export const appThemeClasses = {
  default: "",
  "four-shogi": "game-theme-four-shogi",
} satisfies Record<AppTheme, string>;

export const gameThemes = {
  "four-reversi": "default",
  "four-shogi": "four-shogi",
} as const satisfies Record<GameId, AppTheme>;
