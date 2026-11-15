import { expect, test } from "bun:test";
import { checkGameCommand } from "@tetraboard/context-room";

test("パッケージの入口から共通の確認を呼び出せる", () => {
  expect(
    checkGameCommand({
      operation: "play",
      status: "waiting",
      hasLastRound: false,
      seat: null,
      eliminatedSeats: [],
      turn: null,
      positionMatches: false,
      clockExpired: false,
    }),
  ).toBe("game_not_started");
});
