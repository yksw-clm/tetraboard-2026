import { expect, test } from "bun:test";
import {
  applyAction,
  eliminateSide,
  captureEliminatedHands,
  type EliminationReason,
} from "../src/index";
import { fixture, move, drop, succeeded } from "./helpers";

const hand = { rook: 1, gold: 2, silver: 3, pawn: 12 };
for (const mode of ["singles", "doubles"] as const) {
  for (const reason of [
    "checkmate",
    "no_legal_actions",
    "resigned",
    "left",
    "timeout",
    "disconnected",
  ] as const) {
    test(`${mode}/${reason}: 脱落時の4種類を不変な表示データとして保持する`, () => {
      const before = fixture({ mode, turn: "west", hands: { west: hand } });
      const after = {
        ...before,
        hands: { ...before.hands, west: { rook: 0, gold: 0, silver: 0, pawn: 0 } },
        eliminations: [
          { side: "west" as const, reason: reason as EliminationReason, rank: 4, group: 1 },
        ],
      };
      const original = JSON.stringify({ before, after });
      const retained = captureEliminatedHands({}, before, after);
      expect(retained).toEqual({ west: hand });
      expect(retained.west).not.toBe(before.hands.west);
      expect(captureEliminatedHands(retained, after, after)).toBe(retained);
      expect(JSON.stringify({ before, after })).toBe(original);
    });
  }
}

test("同時詰みと後続脱落を個別に記録し、既存枚数を上書きしない", () => {
  const before = fixture({
    kings: { south: "E9" },
    hands: { west: hand, north: { pawn: 1 } },
    pieces: [
      { side: "south", kind: "rook", at: "E2" },
      { side: "south", kind: "rook", at: "B1" },
      { side: "south", kind: "rook", at: "H1" },
      { side: "south", kind: "gold", at: "B3" },
      { side: "south", kind: "gold", at: "H3" },
    ],
  });
  const after = succeeded(applyAction(before, "south", move("E2", "E1"))).state;
  const retained = captureEliminatedHands({}, before, after);
  expect(retained).toEqual({ west: hand, north: { rook: 0, gold: 0, silver: 0, pawn: 1 } });
  const final = succeeded(eliminateSide(after, "east", "left")).state;
  expect(captureEliminatedHands(retained, after, final)).toEqual({
    ...retained,
    east: { rook: 0, gold: 0, silver: 0, pawn: 0 },
  });
  expect(after.hands.west.pawn).toBe(0);
});

test("着手による捕獲・打ち駒後の枚数を表示し、成駒捕獲は不成で数える", () => {
  for (const action of [move("E5", "E4"), drop("pawn", "D5")]) {
    const before = fixture({
      hands: { south: hand },
      pieces: [
        { side: "south", kind: "rook", at: "E5" },
        { side: "west", kind: "silver", at: "E4", promoted: true },
      ],
    });
    const moved = succeeded(applyAction(before, "south", action)).state;
    const after = succeeded(eliminateSide(moved, "south", "left")).state;
    expect(captureEliminatedHands({}, before, after).south).toEqual({
      ...hand,
      ...(action.type === "dropPiece" ? { pawn: 11 } : { silver: 4 }),
    });
    expect(after.hands.south.pawn).toBe(0);
  }
});

test("脱落がなければ空の情報を保持し、脱落済みの未知枚数を補完しない", () => {
  const before = fixture();
  const empty = {};
  expect(captureEliminatedHands(empty, before, before)).toBe(empty);
  const after = succeeded(eliminateSide(before, "west", "timeout")).state;
  expect(captureEliminatedHands(empty, after, after)).toBe(empty);
});
