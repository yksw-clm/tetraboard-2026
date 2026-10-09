import type { GameId } from "@tetraboard/protocol/games";

export type AppTheme = "default" | "four-shogi" | "reversi";

export const appThemeClasses = {
  default: "",
  reversi: "game-theme-reversi",
  "four-shogi": "game-theme-four-shogi",
} satisfies Record<AppTheme, string>;

export const gameThemes = {
  reversi: "reversi",
  "four-reversi": "default",
  "four-shogi": "four-shogi",
} as const satisfies Record<GameId, AppTheme>;
