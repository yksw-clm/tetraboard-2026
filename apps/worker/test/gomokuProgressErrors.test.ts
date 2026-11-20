import { expect, test } from "vitest";
import type { ForbiddenReason } from "@tetraboard/gomoku";
import { gomokuMoveError } from "../src/adapters/room/games/gomoku/progressErrors";

test.each<[ForbiddenReason[], string]>([
  [["double_three"], "gomoku_double_three"],
  [["double_four"], "gomoku_double_four"],
  [["overline"], "gomoku_overline"],
  [["double_four", "double_three"], "gomoku_double_three_double_four"],
  [["overline", "double_three"], "gomoku_double_three_overline"],
  [["overline", "double_four"], "gomoku_double_four_overline"],
  [["overline", "double_four", "double_three"], "gomoku_double_three_double_four_overline"],
])("禁手 %j は従来のコード %s へ変換する", (forbidden, code) => {
  const before = [...forbidden];
  expect(gomokuMoveError({ type: "forbidden", forbidden })).toBe(code);
  expect(forbidden).toEqual(before);
});

test.each(["game_finished", "out_of_bounds", "occupied", "not_your_turn"] as const)(
  "ルールの拒否 %s は従来の invalid_move へ変換する",
  (type) => expect(gomokuMoveError({ type })).toBe("invalid_move"),
);
