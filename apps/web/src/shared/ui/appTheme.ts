import type { GameId } from "@tetraboard/protocol/games";

export type AppTheme = "default" | "four-shogi" | "reversi" | "shogi" | "gomoku";

export const appThemeClasses = {
  default: "",
  gomoku: "game-theme-gomoku",
  shogi: "game-theme-four-shogi game-theme-shogi",
  reversi: "game-theme-reversi",
  "four-shogi": "game-theme-four-shogi",
} satisfies Record<AppTheme, string>;

export const gameThemes = {
  "four-gomoku": "gomoku",
  gomoku: "gomoku",
  shogi: "shogi",
  reversi: "reversi",
  "four-reversi": "default",
  "four-shogi": "four-shogi",
} as const satisfies Record<GameId, AppTheme>;
