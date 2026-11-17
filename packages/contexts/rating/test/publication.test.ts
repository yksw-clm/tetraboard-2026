import { expect, test } from "bun:test";
import {
  reserveRating,
  cancelRating,
  prepareEloRating,
  prepareLatestRating,
  eloPolicy,
  ratedTimeControls,
} from "../src";
import { MemoryPublication } from "./memoryPorts";

test("保存待ちは現在の席の操作だけが予約でき、再送と別ゲームの予約を分離する", () => {
  const store = new MemoryPublication();
  store.seats.set("a", "op");
  const write = reserveRating(store, "shogi", "first", "a", "op");
  expect(store.pending.size).toBe(0);
  expect(reserveRating(store, "shogi", "wrong", "a", "old")()).toBe(0);
  expect(write()).toBe(1);
  expect(reserveRating(store, "shogi", "second", "a", "op")()).toBe(0);
  reserveRating(store, "reversi", "other", "a", "op")();
  expect(store.pending).toEqual(
    new Map([
      ["shogi:a", "first"],
      ["reversi:a", "other"],
    ]),
  );
  cancelRating(store, "shogi", "old")();
  expect(store.pending.get("shogi:a")).toBe("first");
  const cancel = cancelRating(store, "shogi", "first");
  expect(store.pending.size).toBe(2);
  cancel();
  cancel();
  expect(store.pending).toEqual(new Map([["reversi:a", "other"]]));
});
test.each(["shogi", "reversi"] as const)("%s の更新と保存済み予約の削除をこの順で返す", (game) => {
  const store = new MemoryPublication();
  store.pending.set(`${game}:a`, "match");
  const writes = prepareEloRating(store, game, "match");
  expect(store.policy).toEqual(eloPolicy);
  expect(store.clocks).toEqual(ratedTimeControls(game));
  expect(store.events).toEqual([]);
  expect(store.pending.size).toBe(1);
  expect(writes[1]!()).toBe(0);
  store.published.add(`${game}:match`);
  writes[0]!();
  writes[1]!();
  expect(store.events).toEqual([`update:${game}:match`]);
  expect(store.pending.size).toBe(0);
});
test("最新レートも batch に渡す準備だけを行う", () => {
  const store = new MemoryPublication();
  expect(typeof prepareLatestRating(store, "four-shogi", "a")).toBe("function");
  expect(store.events).toEqual([]);
});
