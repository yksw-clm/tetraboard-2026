import { createInitialState, applyAction } from "./index";
import { positionForSide } from "./board";
import { positionKey } from "./repetition";
import { sides, type FourShogiAction, type FourShogiState } from "./types";

let entries: Map<string, FourShogiAction> | undefined;

function key(state: FourShogiState): string {
  return JSON.stringify([state.mode, state.threePlayerAttackProhibited, positionKey(state)]);
}

export function getOpeningAction(state: FourShogiState): FourShogiAction | undefined {
  if (state.status !== "playing" || state.moveNumber >= 4 || state.eliminations.length > 0) return;
  if (!entries) {
    const built = new Map<string, FourShogiAction>();
    // 初期配置から中央歩を進める系列を構成し、全設定で合法性を確認します。
    for (const mode of ["singles", "doubles"] as const)
      for (const restricted of [false, true]) {
        let position = createInitialState({
          mode,
          threePlayerAttackProhibited: restricted,
          players: { south: "s", west: "w", north: "n", east: "e" },
        });
        for (const side of sides) {
          const action: FourShogiAction = Object.freeze({
            type: "movePiece",
            from: Object.freeze(positionForSide({ x: 4, y: 6 }, side)),
            to: Object.freeze(positionForSide({ x: 4, y: 5 }, side)),
            promote: false,
          });
          const result = applyAction(position, side, action);
          if (!result.ok) throw new Error("序盤候補の構成に失敗しました");
          built.set(key(position), action);
          position = result.state;
        }
      }
    entries = built;
  }
  return entries.get(key(state));
}
