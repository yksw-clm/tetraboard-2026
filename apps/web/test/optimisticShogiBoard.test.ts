import { expect, test } from "bun:test";
import { applyAction, getLegalActions, sides } from "@tetraboard/four-shogi";
import { publicShogiState, tacticalShogiState } from "./fixtures/fourShogiFixtures";
import { optimisticShogiBoard } from "../src/features/room/optimisticShogiBoard";

test("各陣営の合法手の盤・持ち駒はエンジンと一致し、確定情報と入力は変更しない", () => {
  const cases = new Set<string>();
  for (const side of sides) {
    const state = tacticalShogiState(side);
    // 成駒を取ったときも持ち駒は元の種類になる。
    state.board[5]![4]!.promoted = true;
    const publicState = publicShogiState(state);
    const before = structuredClone(publicState);
    for (const action of getLegalActions(state)) {
      const accepted = applyAction(state, side, action);
      if (!accepted.ok) throw new Error(accepted.reason);
      const preview = optimisticShogiBoard(publicState, side, action);
      expect(preview.board).toEqual(accepted.state.board);
      expect(preview.hands).toEqual(accepted.state.hands);
      expect(preview.turn).toBe(publicState.turn);
      expect(preview.status).toBe(publicState.status);
      expect(preview.eliminations).toEqual(publicState.eliminations);
      expect(preview.lastMove).toBeNull();
      expect(publicState).toEqual(before);
      cases.add(action.type);
      if (action.type === "movePiece" && action.promote) cases.add("promotion");
      if (action.type === "movePiece" && state.board[action.to.y]![action.to.x])
        cases.add("capture");
    }
  }
  expect([...cases].sort()).toEqual(["capture", "dropPiece", "movePiece", "promotion"]);
});
