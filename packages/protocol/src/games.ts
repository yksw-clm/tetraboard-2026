// 順序はゲーム選択の表示順です。all はゲームIDに含めません。
export const gameIds = ["four-reversi", "four-shogi"] as const;
export type GameId = (typeof gameIds)[number];
export const defaultGameId = "four-reversi" satisfies GameId;

export const gameScopeIds = ["all", ...gameIds] as const;
export type GameScope = (typeof gameScopeIds)[number];

type GameMetadata = {
  name: string;
  lobbyPath: string;
  rankingsPath: string;
};

export const gameCatalog = {
  "four-reversi": {
    name: "四人リバーシ",
    lobbyPath: "/games/four-reversi",
    rankingsPath: "/games/four-reversi/rankings",
  },
  "four-shogi": {
    name: "四人将棋",
    lobbyPath: "/games/four-shogi",
    rankingsPath: "/games/four-shogi/rankings",
  },
} as const satisfies Record<GameId, GameMetadata>;

export function isGameId(value: unknown): value is GameId {
  return gameIds.some((id) => id === value);
}

export function isGameScope(value: unknown): value is GameScope {
  return value === "all" || isGameId(value);
}
