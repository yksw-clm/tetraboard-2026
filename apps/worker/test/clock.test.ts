import { roomTimeControl } from "@tetraboard/protocol";
import { expect, test } from "vitest";
import { advanceClock, createClock, isClockExpired } from "../src/rooms/clock";

test("期限ちょうどから時間切れとする", () => {
  const clock = createClock(1_000);
  expect(isClockExpired(clock, clock.turnExpiresAt - 1)).toBe(false);
  expect(isClockExpired(clock, clock.turnExpiresAt)).toBe(true);
});

test("基本時間は手番中の経過時間だけ減る", () => {
  const initial = createClock(1_000);
  expect(initial.remainingMainMs.black).toBe(roomTimeControl.mainTimeMs);
  expect(initial.turnExpiresAt).toBe(1_000 + 300_000 + 30_000);

  const next = advanceClock(initial, "black", "white", 61_000, true);
  expect(next.remainingMainMs.black).toBe(240_000);
  expect(next.remainingMainMs.white).toBe(300_000);
  expect(next.turnExpiresAt).toBe(61_000 + 300_000 + 30_000);
});

test("基本時間を使い切った手番から秒読みになり、次の手番は30秒に戻る", () => {
  const initial = createClock(0);
  const white = advanceClock(initial, "black", "white", 310_000, true);
  expect(white.remainingMainMs.black).toBe(0);

  const black = advanceClock(white, "white", "black", 311_000, true);
  expect(black.turnExpiresAt).toBe(341_000);
  const whiteAgain = advanceClock(black, "black", "white", 340_000, true);
  expect(whiteAgain.remainingMainMs.black).toBe(0);
  const blackAgain = advanceClock(whiteAgain, "white", "black", 341_000, true);
  expect(blackAgain.turnExpiresAt).toBe(371_000);
});

test("自動パスで同じ色の手番になっても1手分の秒読みを新たに与える", () => {
  const initial = createClock(0);
  const overtime = { ...initial, remainingMainMs: { ...initial.remainingMainMs, black: 0 } };
  const next = advanceClock(overtime, "black", "black", 1_000, true);
  expect(next.turnStartedAt).toBe(1_000);
  expect(next.turnExpiresAt).toBe(31_000);
});

test("他人が脱落しても現在の手番は進まず、終局時は時計を固定する", () => {
  const initial = createClock(0);
  expect(advanceClock(initial, "black", "black", 10_000, false)).toBe(initial);
  const finished = advanceClock(initial, "black", null, 10_000, true);
  expect(finished.remainingMainMs.black).toBe(290_000);
  expect(finished.turnStartedAt).toBeNull();
  expect(finished.turnExpiresAt).toBeNull();
});
