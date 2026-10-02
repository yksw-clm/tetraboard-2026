import { expect, test } from "bun:test";
import { applyAction, createInitialState, getActiveSides, getLegalActions } from "../src/index";
import { succeeded } from "./helpers";

for (const mode of ["singles", "doubles"] as const) {
  for (const threePlayerAttackProhibited of [false, true]) {
    test(`${mode}・三人攻撃禁止${threePlayerAttackProhibited ? "ON" : "OFF"}の連続着手でも状態の整合を保つ`, () => {
      let state = createInitialState({
        mode,
        threePlayerAttackProhibited,
        players: { south: "s", west: "w", north: "n", east: "e" },
      });
      let seed = 314159;
      for (let step = 0; step < 100 && state.status === "playing"; step++) {
        const before = JSON.stringify(state);
        const legal = getLegalActions(state);
        expect(legal.length).toBeGreaterThan(0);
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const result = succeeded(applyAction(state, state.turn, legal[seed % legal.length]));
        expect(JSON.stringify(state)).toBe(before);
        state = result.state;
        const pieces = state.board.flat().filter((piece) => piece !== null);
        expect(new Set(pieces.map(({ id }) => id)).size).toBe(pieces.length);
        expect(pieces.filter(({ kind }) => kind === "king").length).toBe(4);
        expect(pieces.every(({ id }) => id < state.nextPieceId)).toBe(true);
        const counts = Object.values(state.hands).flatMap((hand) => Object.values(hand));
        expect(counts.every((count) => Number.isInteger(count) && count >= 0)).toBe(true);
        expect(
          pieces.length + counts.reduce((total, count) => total + count, 0),
        ).toBeLessThanOrEqual(36);
        expect(state.moveNumber).toBe(step + 1);
        if (state.status === "playing") expect(getActiveSides(state)).toContain(state.turn);
      }
    });
  }
}
