import { expect, test } from "bun:test";
import { fourShogiPublicStateSchema } from "../src/fourShogi";
import { shogiPublicStateSchema } from "../src/shogi";
import fourShogi from "../../../test-fixtures/matches/shogi-singles.json";

const emptyHand = { rook: 0, bishop: 0, gold: 0, silver: 0, knight: 0, lance: 0, pawn: 0 };
const shogi = {
  rulesVersion: 1,
  players: { south: "south", north: "north" },
  board: Array.from({ length: 9 }, () => Array(9).fill(null)),
  hands: { south: emptyHand, north: emptyHand },
  eliminations: [],
  drawProposals: [],
  nonChecks: { south: 0, north: 0 },
  nextPieceId: 1,
  moveNumber: 0,
  lastMove: null,
  status: "finished",
  turn: null,
  result: { winner: null, reason: "repetition" },
};

for (const [name, schema, finished] of [
  ["四人将棋", fourShogiPublicStateSchema, fourShogi.detail.game],
  ["将棋", shogiPublicStateSchema, shogi],
] as const) {
  for (const status of ["playing", "finished"] as const) {
    test(`${name}の${status}: 引分提案は必須で、欠落・null・不正な配列を拒否する`, () => {
      const game =
        status === "finished" ? finished : { ...finished, status, turn: "south", result: null };
      expect(schema.safeParse(game).success).toBe(true);
      const { drawProposals: _proposals, ...missing } = game;
      expect(schema.safeParse(missing).success).toBe(false);
      for (const drawProposals of [null, ["south", "south"], ["unknown"]])
        expect(schema.safeParse({ ...game, drawProposals }).success).toBe(false);
      expect(schema.safeParse({ ...game, drawProposals: [] }).success).toBe(true);
      expect(schema.safeParse({ ...game, drawProposals: ["south"] }).success).toBe(true);
    });
  }
}
