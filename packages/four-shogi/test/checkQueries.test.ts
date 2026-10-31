import { expect, test } from "bun:test";
import { fixture } from "../bench/positionFixture";
import { getCheckState, isInCheck, attacksSquare, pieces } from "../src/board";
import { areEnemies, getActiveSides, sides, type FourShogiState } from "../src/types";

function referenceChecks(state: FourShogiState) {
  const active = getActiveSides(state),
    board = pieces(state.board);
  return Object.fromEntries(
    sides.map((side) => {
      const king = board.find((entry) => entry.piece.side === side && entry.piece.kind === "king");
      return [
        side,
        active.includes(side) &&
          !!king &&
          board.some(
            (attacker) =>
              active.includes(attacker.piece.side) &&
              areEnemies(state.mode, side, attacker.piece.side) &&
              attacksSquare(state.board, attacker.piece, attacker.position, king.position),
          ),
      ];
    }),
  ) as ReturnType<typeof getCheckState>;
}

test("王手判定は全駒の幾何判定と一致し、死駒の遮蔽・成飛車・味方を保つ", () => {
  let random = 9820000;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  for (const mode of ["singles", "doubles"] as const)
    for (let sample = 0; sample < 300; sample++) {
      const pieces = Array.from({ length: 20 }, () => {
        const side = sides[(next() >>> 16) % 4],
          kind = (["rook", "gold", "silver", "pawn"] as const)[(next() >>> 16) % 4];
        let x = (next() >>> 16) % 9,
          y = (next() >>> 16) % 9;
        while ((x === 0 || x === 8) && (y === 0 || y === 8)) {
          x = (next() >>> 16) % 9;
          y = (next() >>> 16) % 9;
        }
        return {
          side,
          kind,
          at: String.fromCharCode(65 + x) + (y + 1),
          promoted: ((next() >>> 16) & 1) === 1,
        };
      });
      const state = fixture({
        mode,
        pieces,
        eliminations:
          sample % 3 === 0
            ? [{ side: "west", rank: mode === "singles" ? 4 : null, group: 1, reason: "resigned" }]
            : [],
      });
      const before = structuredClone(state),
        expected = referenceChecks(state);
      expect(getCheckState(state)).toEqual(expected);
      for (const side of sides) expect(isInCheck(state, side)).toBe(expected[side]);
      expect(state).toEqual(before);
    }
});

test("王手の照合結果を状態外へ持ち越さず、同じ盤面の脱落・モード変更を反映する", () => {
  const base = fixture({
    kings: { south: "E5", north: "I1", west: "A1", east: "I9" },
    pieces: [{ side: "north", kind: "rook", at: "E1" }],
  });
  expect(isInCheck(base, "south")).toBe(true);
  expect(isInCheck({ ...base, mode: "doubles" }, "south")).toBe(false);
  expect(
    isInCheck(
      { ...base, eliminations: [{ side: "north", rank: 4, group: 1, reason: "resigned" }] },
      "south",
    ),
  ).toBe(false);
  const blocked = fixture({
    kings: { south: "E5" },
    pieces: [
      { side: "north", kind: "rook", at: "E1" },
      { side: "west", kind: "pawn", at: "E3" },
    ],
    eliminations: [{ side: "west", rank: 4, group: 1, reason: "resigned" }],
  });
  expect(isInCheck(blocked, "south")).toBe(false);
});
