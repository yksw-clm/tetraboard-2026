import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { positionForSide } from "../../../packages/four-shogi/src/board";
import { sides, type FourShogiState } from "../../../packages/four-shogi/src/types";

/** 従来search CLIのシングルス/有効マジック集合を、採点条件を変えず共用します。 */
export function studyTacticalCases() {
  const cases = tacticalCases().filter((entry) => entry.state.mode === "singles");
  for (const restricted of [false, true])
    for (const [offset, orientation] of sides.entries()) {
      const state = fixture({
        threePlayerAttackProhibited: restricted,
        kings: { south: "A8", east: "C8" },
        pieces: [
          { side: "south", kind: "rook", at: "E3" },
          { side: "west", kind: "gold", at: "C3" },
          { side: "north", kind: "silver", at: "B4" },
        ],
      });
      const board = state.board.map((row) =>
        row.map(() => null),
      ) as FourShogiState["board"][number][number][][];
      for (let y = 0; y < 9; y++)
        for (let x = 0; x < 9; x++) {
          const piece = state.board[y][x];
          const to = positionForSide({ x, y }, orientation);
          board[to.y][to.x] = piece
            ? { ...piece, side: sides[(sides.indexOf(piece.side) + offset) % 4] }
            : null;
        }
      cases.push({
        id: `valid-magic-${restricted}-${orientation}`,
        family: "valid-magic",
        split: "validation",
        criterion: "magic",
        critical: true,
        proof: "西の金を取り東王へ王手し、北銀の取り返しより先に南へ戻る",
        state: { ...state, status: "playing", result: null, board, turn: orientation },
      });
    }

  return cases;
}
