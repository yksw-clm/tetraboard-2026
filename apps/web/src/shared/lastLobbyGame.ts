import {
  defaultGameId,
  gameCatalog,
  gameIds,
  isGameId,
  type GameId,
} from "@tetraboard/protocol/games";

export const lastLobbyGameKey = "tetraboard:last-lobby-game";

export function lobbyGameForNavigation(path: string): GameId | undefined {
  return gameIds.find((game) => path.replace(/\/$/, "") === gameCatalog[game].lobbyPath);
}

export class LastLobbyGameStore {
  private game: GameId = defaultGameId;
  private unsaved = false;
  private listeners = new Set<() => void>();
  private readonly storage: () => Pick<Storage, "getItem" | "setItem">;

  constructor(storage: () => Pick<Storage, "getItem" | "setItem">) {
    this.storage = storage;
    this.sync();
  }

  getSnapshot = (): GameId => this.game;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(game: GameId): void {
    if (this.game === game) return;
    this.game = game;
    for (const listener of this.listeners) listener();
  }

  visit(path: string): void {
    const game = lobbyGameForNavigation(path);
    if (!game) return;
    try {
      this.storage().setItem(lastLobbyGameKey, game);
      this.unsaved = false;
    } catch {
      // 保存できない場合も、開いている画面では直近のゲームを保持します。
      this.unsaved = true;
    }
    this.publish(game);
  }

  sync(value?: string | null): void {
    if (this.unsaved) return;
    try {
      const stored = value === undefined ? this.storage().getItem(lastLobbyGameKey) : value;
      this.publish(isGameId(stored) ? stored : defaultGameId);
    } catch {
      // 保存領域を利用できなくてもナビゲーションを継続します。
    }
  }
}

export const lastLobbyGame = new LastLobbyGameStore(() => localStorage);

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== lastLobbyGameKey && event.key !== null) return;
    try {
      if (event.storageArea !== null && event.storageArea !== localStorage) return;
      lastLobbyGame.sync(event.key === null ? null : event.newValue);
    } catch {
      lastLobbyGame.sync();
    }
  });
  window.addEventListener("pageshow", () => lastLobbyGame.sync());
}
