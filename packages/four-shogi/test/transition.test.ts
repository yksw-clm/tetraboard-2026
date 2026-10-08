import { expect, test } from "bun:test";
import { applyAction } from "../src/index";
import { applyLegalMove, getLegalMoves } from "../src/transition";
import { openingPosition } from "../bench/measurement";
import { fixture, position } from "./helpers";

for (const mode of ["singles", "doubles"] as const) {
  for (const restriction of [true, false]) {
    test(`共有の確定処理と公開APIは${mode}・三人攻撃${restriction}の全候補で一致する`, () => {
      const state = openingPosition(mode, restriction, 1000);
      if (state.status !== "playing") throw new Error("Expected a playing state");
      const before = structuredClone(state);
      for (const move of getLegalMoves(state)) {
        expect(applyAction(state, state.turn, move.action)).toEqual(
          applyLegalMove(state, state.turn, move),
        );
      }
      expect(state).toEqual(before);
    });
  }
}

test("履歴付き候補も禁止手を除き、枝の反復回数を基底履歴へ書き込まない", () => {
  const state = fixture({
    threePlayerAttackProhibited: true,
    pieces: [
      { side: "south", kind: "silver", at: "E3" },
      { side: "west", kind: "gold", at: "D3", id: 200 },
    ],
    attackRelations: [
      {
        attacker: "north",
        target: "west",
        reasons: ["threat"],
        targetPieceIds: [200],
        pendingSides: ["south", "west", "east"],
      },
      {
        attacker: "east",
        target: "west",
        reasons: ["check"],
        targetPieceIds: [],
        pendingSides: ["south", "west", "north"],
      },
    ],
    recaptureSquares: { south: [position("F3")] },
  });
  const before = structuredClone(state);
  const history = new Map<string, number>();
  const lookup = (key: string) => history.get(key) ?? 2;
  for (const move of getLegalMoves(state)) {
    expect(applyAction(state, "south", move.action, lookup)).toEqual(
      applyLegalMove(state, "south", move, lookup),
    );
  }
  expect(state).toEqual(before);
  expect(history.size).toBe(0);
});
