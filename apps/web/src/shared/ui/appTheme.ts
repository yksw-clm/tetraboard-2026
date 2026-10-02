export type AppTheme = "default" | "four-shogi";

export const appThemeClasses = {
  default: "",
  "four-shogi": "game-theme-four-shogi",
} satisfies Record<AppTheme, string>;
