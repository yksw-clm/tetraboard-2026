import { expect, test } from "bun:test";
import { evaluatePosition } from "../src/cpuEvaluation";
import { attackedPositions, attacksSquare, pieces } from "../src/board";
import { initialPosition } from "../bench/measurement";
import { fixture } from "./helpers";

test("利きの列挙は4方向の初期駒・龍・遮る駒で幾何的な判定と一致する", () => {
  const states = [
    initialPosition("singles", true),
    fixture({
      pieces: [
        { side: "south", kind: "rook", at: "E5", promoted: true },
        { side: "north", kind: "pawn", at: "E2" },
        { side: "south", kind: "gold", at: "H5" },
      ],
    }),
  ];
  for (const state of states)
    for (const { piece, position } of pieces(state.board)) {
      const expected = Array.from({ length: 81 }, (_, index) => ({
        x: index % 9,
        y: Math.floor(index / 9),
      })).filter((to) => attacksSquare(state.board, piece, position, to));
      expect(
        attackedPositions(state.board, piece, position).sort((a, b) => a.y - b.y || a.x - b.x),
      ).toEqual(expected);
    }
});

test("同じ浮き飛車でも、自手番で逃げられる局面より敵が先に取れる局面を低く評価する", () => {
  const state = fixture({
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "west", kind: "pawn", at: "D5" },
    ],
  });
  if (state.status !== "playing") throw new Error("Expected a playing position");
  expect(evaluatePosition({ ...state, turn: "west" }).south).toBeLessThan(
    evaluatePosition(state).south,
  );
});

test("ダブルスの評価は味方が共有し、相手チームと符号が反対になる", () => {
  const scores = evaluatePosition(
    fixture({
      mode: "doubles",
      pieces: [
        { side: "south", kind: "rook", at: "E5" },
        { side: "east", kind: "silver", at: "D5" },
      ],
    }),
  );
  expect(scores.south).toBe(scores.north);
  expect(scores.west).toBe(scores.east);
  expect(scores.south).toBe(-scores.west);
});
