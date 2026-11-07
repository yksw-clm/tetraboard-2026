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

// 表示中のゲームテーマにかかわらず、各ゲームの識別色を使います。
export const gameAccentClasses = {
  "four-reversi": "[--game-accent:var(--color-game-four-reversi)]",
  "four-shogi": "[--game-accent:var(--color-game-four-shogi)]",
  reversi: "[--game-accent:var(--color-game-reversi)]",
  shogi: "[--game-accent:var(--color-game-shogi)]",
  gomoku: "[--game-accent:var(--color-game-gomoku)]",
  "four-gomoku": "[--game-accent:var(--color-game-gomoku)]",
} as const satisfies Record<GameId, string>;
