import { expect, test } from "vitest";
import { nextDueRoomDeadline, earliestAlarmAt } from "../src/rooms/roomDeadlines";

const players = [
  { id: "first", reconnectDeadline: 100 },
  { id: "second", reconnectDeadline: 100 },
  { id: "connected", reconnectDeadline: null },
];
test("期限直前は処理せず、ちょうどで時間切れを切断より先に返す", () => {
  expect(nextDueRoomDeadline(100, players, 99)).toBeNull();
  expect(nextDueRoomDeadline(100, players, 100)).toEqual({ type: "timeout", at: 100 });
  expect(nextDueRoomDeadline(101, players, 100)).toEqual({
    type: "disconnect",
    at: 100,
    playerId: "first",
  });
});
test("遅延時も早い確定時刻を選び、切断同士の同時刻は現在の配列順を維持する", () => {
  expect(nextDueRoomDeadline(90, players, 1_000)).toEqual({ type: "timeout", at: 90 });
  expect(nextDueRoomDeadline(110, players, 1_000)).toEqual({
    type: "disconnect",
    at: 100,
    playerId: "first",
  });
  expect(nextDueRoomDeadline(null, players.toReversed(), 1_000)).toEqual({
    type: "disconnect",
    at: 100,
    playerId: "second",
  });
  expect(players.map((player) => player.id)).toEqual(["first", "second", "connected"]);
});
test("更新後の期限と席から選び直し、到達済みイベントがなくなるまで進む", () => {
  expect(nextDueRoomDeadline(130, [{ id: "remaining", reconnectDeadline: 120 }], 150)).toEqual({
    type: "disconnect",
    at: 120,
    playerId: "remaining",
  });
  expect(nextDueRoomDeadline(130, [], 150)).toEqual({ type: "timeout", at: 130 });
  expect(nextDueRoomDeadline(160, [], 150)).toBeNull();
  expect(nextDueRoomDeadline(null, [], 150)).toBeNull();
});
test("Alarmの最小候補は過去・0・重複も保持し、候補なしだけnullを返す", () => {
  expect(earliestAlarmAt([])).toBeNull();
  expect(earliestAlarmAt([300, 100, 200])).toBe(100);
  expect(earliestAlarmAt([100, 0, 0])).toBe(0);
  expect(earliestAlarmAt([0, -1])).toBe(-1);
});
test("登録待ちの切断期限は保持中に処理せず、保持期限ちょうどで元の切断期限を選ぶ", () => {
  const player = { id: "registering", reconnectDeadline: 100, registrationPendingUntilMs: 600 };
  expect(nextDueRoomDeadline(null, [player], 599)).toBeNull();
  expect(nextDueRoomDeadline(null, [player], 600)).toEqual({
    type: "disconnect",
    playerId: player.id,
    at: 100,
  });
  expect(nextDueRoomDeadline(500, [player], 550)).toEqual({ type: "timeout", at: 500 });
});
