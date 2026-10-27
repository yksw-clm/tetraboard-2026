import { expect, test } from "bun:test";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { LastLobbyGameStore, lastLobbyGameKey } from "../src/shared/lastLobbyGame";

test("直近ゲームはロビー訪問だけを記録し、新しい読み込みでも復元する", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const store = new LastLobbyGameStore(() => storage);
  expect(store.getSnapshot()).toBe("four-reversi");
  for (const game of gameIds) {
    store.visit(gameCatalog[game].lobbyPath);
    expect(store.getSnapshot()).toBe(game);
    expect(values.get(lastLobbyGameKey)).toBe(game);
    expect(new LastLobbyGameStore(() => storage).getSnapshot()).toBe(game);
  }
  for (const path of [
    "/",
    "/how-to-play",
    "/rooms/12345",
    "/matches/match-id",
    "/account",
    "/games/unknown",
    "/games/shogi/rankings",
  ])
    store.visit(path);
  expect(store.getSnapshot()).toBe(gameIds.at(-1)!);
  expect(values.get(lastLobbyGameKey)).toBe(gameIds.at(-1)!);
});

test("不正な保存値は四人リバーシに戻し、保存拒否中も現在のゲームを保持する", () => {
  for (const value of [null, "invalid", '"shogi"', "/games/shogi"]) {
    const store = new LastLobbyGameStore(() => ({ getItem: () => value, setItem: () => {} }));
    expect(store.getSnapshot()).toBe("four-reversi");
  }
  const store = new LastLobbyGameStore(() => {
    throw new Error("storage denied");
  });
  expect(store.getSnapshot()).toBe("four-reversi");
  store.visit("/games/four-shogi");
  expect(store.getSnapshot()).toBe("four-shogi");
  store.sync();
  expect(store.getSnapshot()).toBe("four-shogi");
});
