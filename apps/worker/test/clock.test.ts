import { createShogiClock, advanceShogiClock } from "../src/rooms/shogiClock";
import { roomTimeControl, roomTimeControlSchema } from "@tetraboard/protocol";
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

test.each(
  [0, 60_000, 180_000, 300_000, 600_000].flatMap((mainTimeMs) =>
    [0, 10_000, 30_000]
      .filter((byoyomiMs) => mainTimeMs + byoyomiMs > 0)
      .map((byoyomiMs) => ({ mainTimeMs, byoyomiMs })),
  ),
)("両ゲームのプリセット $mainTimeMs + $byoyomiMs を開始・手番更新へ反映する", (preset) => {
  const control = roomTimeControlSchema.parse(preset);
  const initial = createClock(1_000, control);
  const shogi = createShogiClock(1_000, control);
  for (const clock of [initial, shogi]) {
    expect(Object.values(clock.remainingMainMs)).toEqual(Array(4).fill(control.mainTimeMs));
    expect(clock.turnExpiresAt).toBe(1_000 + control.mainTimeMs + control.byoyomiMs);
    expect(isClockExpired(clock, clock.turnExpiresAt - 1)).toBe(false);
    expect(isClockExpired(clock, clock.turnExpiresAt)).toBe(true);
  }
  const next = advanceClock(initial, "black", "white", 2_000, true, control);
  const shogiNext = advanceShogiClock(shogi, "south", "west", 2_000, true, control);
  expect(next.remainingMainMs.black).toBe(Math.max(0, control.mainTimeMs - 1_000));
  expect(shogiNext.remainingMainMs.south).toBe(next.remainingMainMs.black);
  expect(next.turnExpiresAt).toBe(2_000 + control.mainTimeMs + control.byoyomiMs);
  expect(shogiNext.turnExpiresAt).toBe(next.turnExpiresAt);
  // 同じ手番のまま他人が脱落しても、残り時間や期限を延長しません。
  expect(advanceClock(next, "white", "white", 3_000, false, control)).toBe(next);
  expect(advanceShogiClock(shogiNext, "west", "west", 3_000, false, control)).toBe(shogiNext);
});

test.each([10_000, 30_000])("両ゲームで秒読み %i ms を毎手リセットする", (byoyomiMs) => {
  const control = roomTimeControlSchema.parse({ mainTimeMs: 0, byoyomiMs });
  const initial = createClock(0, control);
  const next = advanceClock(initial, "black", "white", byoyomiMs - 1, true, control);
  const again = advanceClock(next, "white", "black", byoyomiMs, true, control);
  expect(again.turnExpiresAt).toBe(byoyomiMs * 2);
  const passed = advanceClock(again, "black", "black", byoyomiMs + 1, true, control);
  expect(passed.turnExpiresAt).toBe(byoyomiMs * 2 + 1);
  const shogi = createShogiClock(0, control);
  const shogiNext = advanceShogiClock(shogi, "south", "west", byoyomiMs - 1, true, control);
  const shogiAgain = advanceShogiClock(shogiNext, "west", "south", byoyomiMs, true, control);
  expect(shogiAgain.turnExpiresAt).toBe(byoyomiMs * 2);
});

test("1分＋10秒は持ち時間を使い切った手番から10秒になり、再訪時も10秒を与える", () => {
  const control = roomTimeControlSchema.parse({ mainTimeMs: 60_000, byoyomiMs: 10_000 });
  const next = advanceClock(createClock(0, control), "black", "white", 65_000, true, control);
  const again = advanceClock(next, "white", "black", 66_000, true, control);
  expect(again.remainingMainMs.black).toBe(0);
  expect(again.turnExpiresAt).toBe(76_000);
  const shogi = advanceShogiClock(
    createShogiClock(0, control),
    "south",
    "west",
    65_000,
    true,
    control,
  );
  const shogiAgain = advanceShogiClock(shogi, "west", "south", 66_000, true, control);
  expect(shogiAgain.remainingMainMs.south).toBe(0);
  expect(shogiAgain.turnExpiresAt).toBe(76_000);
});
