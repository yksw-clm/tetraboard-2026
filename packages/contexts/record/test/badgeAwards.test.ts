import { expect, test } from "bun:test";
import {
  prepareBadgeAwards,
  type BadgeCatalog,
  type BadgeGame,
  type BadgePublication,
} from "../src";

type Write = () => void;
class MemoryBadgePublication implements BadgePublication<Write> {
  value = 0;
  awardsByTier = new Map<string, string>();
  notifications = new Map<string, number>();

  awards(
    game: BadgeGame,
    matchId: string,
    thresholds: Parameters<BadgePublication<Write>["awards"]>[2],
  ) {
    return () => {
      for (const { id, tier, threshold } of thresholds) {
        const key = `${game}:${id}:${tier}`;
        if (this.value >= threshold && !this.awardsByTier.has(key))
          this.awardsByTier.set(key, matchId);
      }
    };
  }

  notification(matchId: string, now: number) {
    return () => {
      if ([...this.awardsByTier.values()].includes(matchId) && !this.notifications.has(matchId))
        this.notifications.set(matchId, now);
    };
  }
}

const catalog: BadgeCatalog = { ids: () => ["games"], thresholds: () => [5, 20, 100] };

test("付与と通知の順で書き込みを返し、しきい値を越えた段だけ再送を通じて一度ずつ付与する", () => {
  const store = new MemoryBadgePublication();
  const publish = (id: string, now: number) =>
    prepareBadgeAwards(store, catalog, "four-reversi", id, () => now).forEach((write) => write());

  store.value = 4;
  publish("below", 100);
  expect(store.notifications.size).toBe(0);

  store.value = 5;
  const writes = prepareBadgeAwards(store, catalog, "four-reversi", "first", () => 200);
  expect(store.awardsByTier.size).toBe(0);
  writes.forEach((write) => write());
  publish("first", 300);
  publish("same-tier", 400);

  store.value = 20;
  publish("upgrade", 500);
  expect([...store.awardsByTier]).toEqual([
    ["four-reversi:games:1", "first"],
    ["four-reversi:games:2", "upgrade"],
  ]);
  expect([...store.notifications]).toEqual([
    ["first", 200],
    ["upgrade", 500],
  ]);
});

test("バッジ対象外のゲームの書き込みは準備しない", () => {
  const store = new MemoryBadgePublication();
  expect(prepareBadgeAwards(store, catalog, "shogi", "match", () => 100)).toEqual([]);
});
