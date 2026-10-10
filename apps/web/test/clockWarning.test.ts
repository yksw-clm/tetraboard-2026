import { expect, test } from "bun:test";
import {
  ClockWarningTracker,
  type ClockCount,
  roomClockCount,
} from "../src/features/room/clockWarning";
import { clockPresentation } from "../src/features/room/roomClockPresentation";
import { playingRoom, now, membership, waitingRoom } from "./fixtures/rooms";
import { playingShogiRoom } from "./fixtures/fourShogiFixtures";

const count: ClockCount = { id: "first", playerId: "self", expiresAt: 10_000 };

test("5,001/5,000/4,999/1/0msをミリ秒で判定し、遅いtickも期限前なら1回通知", () => {
  for (const remaining of [5001, 5000, 4999, 1, 0, -1]) {
    const tracker = new ClockWarningTracker();
    tracker.baseline(count, 0);
    expect(tracker.observe(count, count.expiresAt - remaining, "self")).toBe(
      remaining > 0 && remaining <= 5000 ? remaining : null,
    );
    if (remaining <= 5000) expect(tracker.observe(count, 5000, "self")).toBeNull();
  }
});

test("同期補正・復帰でも通知済みを保持し、新手番と同一人物の連続手番では再通知", () => {
  const tracker = new ClockWarningTracker();
  tracker.baseline(count, 0);
  expect(tracker.observe(count, 5000, "self")).toBe(5000);
  tracker.baseline(count, 3000);
  expect(tracker.observe(count, 5000, "self")).toBeNull();
  expect(tracker.observe({ ...count, id: "next" }, 6000, "self")).toBe(4000);
  tracker.consume({ ...count, id: "sent" });
  expect(tracker.observe({ ...count, id: "sent" }, 6000, "self")).toBeNull();
});

test("基準取得時の残り5秒以下・観戦・他人・CPUでは鳴らさず、復帰後の未来の境界だけ通知", () => {
  for (const remaining of [5000, 3000, 0]) {
    const tracker = new ClockWarningTracker();
    tracker.baseline(count, 10_000 - remaining);
    expect(tracker.observe(count, 7000, "self")).toBeNull();
  }
  for (const playerId of [null, "other"]) {
    const tracker = new ClockWarningTracker();
    expect(tracker.observe(count, 5000, playerId)).toBeNull();
  }
  const tracker = new ClockWarningTracker();
  expect(tracker.observe({ ...count, playerId: null }, 5000, "self")).toBeNull();
  tracker.baseline({ ...count, id: "restored" }, 4000);
  expect(tracker.observe({ ...count, id: "restored" }, 5000, "self")).toBe(5000);
});

test("同じ席でも手番開始・手数・部屋世代が違えば別カウント、待機は時計音対象外", () => {
  const room = playingRoom();
  if (room.status !== "playing") throw Error("fixture");
  const first = roomClockCount(room)!;
  expect(first.playerId).toBe(membership.playerId);
  room.clock.turnStartedAt++;
  expect(roomClockCount(room)!.id).not.toBe(first.id);
  room.clock.turnStartedAt--;
  room.game.moveNumber++;
  expect(roomClockCount(room)!.id).not.toBe(first.id);
  room.game.moveNumber--;
  room.instanceId = crypto.randomUUID();
  expect(roomClockCount(room)!.id).not.toBe(first.id);
  expect(roomClockCount(waitingRoom())).toBeNull();
});

test("3時間構成の強調は最終期限の5秒境界で一致し、持ち時間終了前は強調しない", () => {
  for (const timeControl of [
    { mainTimeMs: 60_000, byoyomiMs: 30_000 },
    { mainTimeMs: 60_000, byoyomiMs: 0 },
    { mainTimeMs: 0, byoyomiMs: 10_000 },
  ]) {
    const expiry = now + timeControl.mainTimeMs + timeControl.byoyomiMs;
    const args = { timeControl, isTurn: true, turnStartedAt: now, turnExpiresAt: expiry };
    for (const remaining of [9000, 6000, 5001, 5000, 4999, 1, 0, -1]) {
      expect(clockPresentation({ ...args, serverNowMs: expiry - remaining }).urgent).toBe(
        remaining <= 5000,
      );
    }
    expect(clockPresentation({ ...args, isTurn: false, serverNowMs: expiry }).urgent).toBe(false);
    expect(clockPresentation({ timeControl, serverNowMs: expiry }).urgent).toBe(false);
    if (timeControl.mainTimeMs && timeControl.byoyomiMs)
      expect(
        clockPresentation({ ...args, serverNowMs: now + timeControl.mainTimeMs - 5000 }).urgent,
      ).toBe(false);
  }
});

test("将棋のrevision・引分提案は同じカウント、次局は別カウント、脱落者には通知しない", () => {
  const room = playingShogiRoom();
  const count = roomClockCount(room)!;
  room.positionRevision++;
  room.game.drawProposals = [room.game.turn];
  expect(roomClockCount(room)!.id).toBe(count.id);
  room.roundId = crypto.randomUUID();
  expect(roomClockCount(room)!.id).not.toBe(count.id);
  room.game.eliminations.push({ side: room.game.turn, rank: 4, reason: "resign", group: 1 });
  expect(roomClockCount(room)!.playerId).toBeNull();
});
