import { expect, test } from "bun:test";
import { clockPresentation } from "../src/features/room/roomClockPresentation";
import { parseRegistrationReturn } from "../src/features/account/registrationReturn";

test("持ち時間なしは待機中から秒読みを表示し、10秒と9秒を区別する", () => {
  const timeControl = { mainTimeMs: 0, byoyomiMs: 10_000 };
  expect(clockPresentation({ timeControl, serverNowMs: 0 })).toEqual({
    text: "00:10",
    byoyomi: true,
    urgent: false,
  });
  expect(
    clockPresentation({ timeControl, turnExpiresAt: 10_000, isTurn: true, serverNowMs: 1000 }),
  ).toEqual({ text: "00:09", byoyomi: true, urgent: true });
  expect(
    clockPresentation({ timeControl, turnExpiresAt: 10_000, isTurn: true, serverNowMs: 10_000 }),
  ).toEqual({ text: "00:00", byoyomi: true, urgent: true });
});

test("秒読みなしは期限前後も持ち時間として表示する", () => {
  const timeControl = { mainTimeMs: 60_000, byoyomiMs: 0 };
  const args = { timeControl, turnExpiresAt: 60_000, isTurn: true };
  expect(clockPresentation({ ...args, serverNowMs: 59_000 })).toEqual({
    text: "00:01",
    byoyomi: false,
    urgent: false,
  });
  expect(clockPresentation({ ...args, serverNowMs: 60_000 })).toEqual({
    text: "00:00",
    byoyomi: false,
    urgent: false,
  });
  expect(clockPresentation({ ...args, serverNowMs: 61_000 })).toEqual({
    text: "00:00",
    byoyomi: false,
    urgent: false,
  });
});

test("1分＋10秒は持ち時間から秒読みへ移行する", () => {
  const args = {
    timeControl: { mainTimeMs: 60_000, byoyomiMs: 10_000 },
    turnExpiresAt: 70_000,
    isTurn: true,
  };
  expect(clockPresentation({ ...args, serverNowMs: 59_000 })).toEqual({
    text: "00:01",
    byoyomi: false,
    urgent: false,
  });
  expect(clockPresentation({ ...args, serverNowMs: 60_000 })).toEqual({
    text: "00:10",
    byoyomi: true,
    urgent: false,
  });
  expect(clockPresentation({ ...args, serverNowMs: 61_000 })).toEqual({
    text: "00:09",
    byoyomi: true,
    urgent: true,
  });
});

test("登録復帰は時間設定を検証して保持し、省略した旧データも扱う", () => {
  const value = {
    path: "/games/four-reversi",
    createdAt: 1000,
    oauthStarted: true,
    entry: { intent: "create", name: "入力中", roomCode: "", mode: "singles" },
  };
  expect(parseRegistrationReturn(value, 1000)?.entry).toEqual(value.entry);
  const timeControl = { mainTimeMs: 0, byoyomiMs: 10_000 };
  expect(
    parseRegistrationReturn({ ...value, entry: { ...value.entry, timeControl } }, 1000)?.entry
      ?.timeControl,
  ).toEqual(timeControl);
  expect(
    parseRegistrationReturn(
      { ...value, entry: { ...value.entry, timeControl: { mainTimeMs: 0, byoyomiMs: 0 } } },
      1000,
    ),
  ).toBeNull();
});
