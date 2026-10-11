import { expect, test } from "bun:test";
import { applyAction, colors, createInitialState, getLegalMoves } from "../src/index";
import { applyLegalPlacement, getLegalPlacements } from "../src/engine";
import { positionAt } from "../bench/measurement";

test("生成済みの全候補と公開APIは両モード・脱落・パス・終局まで一致する", () => {
  let tested = 0;
  for (const mode of ["singles", "doubles"] as const)
    for (const active of mode === "singles" ? [2, 3, 4] : [4])
      for (const ply of [0, 12, 28, 44, 52, 55]) {
        const state = positionAt(mode, 100 + ply, ply, active);
        if (state.status !== "playing") continue;
        const before = structuredClone(state);
        const placements = getLegalPlacements(state);
        expect(placements.map((move) => move.position)).toEqual(getLegalMoves(state));
        for (const placement of placements) {
          const publicResult = applyAction(state, {
            type: "placeStone",
            position: placement.position,
          });
          if (!publicResult.ok) throw new Error("公開APIが合法候補を拒否しました");
          expect(applyLegalPlacement(state, placement)).toEqual(publicResult);
          tested++;
        }
        expect(state).toEqual(before);
      }
  expect(tested).toBeGreaterThan(100);
});

test("別盤面・別手番・脱落色が異なる元局面へ候補を流用しない", () => {
  const state = createInitialState("singles");
  if (state.status !== "playing") throw new Error("初期状態が終局しています");
  const move = getLegalPlacements(state)[0];
  expect(() => applyLegalPlacement(structuredClone(state), move)).toThrow("元局面");
  expect(() => applyLegalPlacement({ ...state, turn: "red" }, move)).toThrow("元局面");
  expect(() => applyLegalPlacement({ ...state, eliminatedColors: ["blue"] }, move)).toThrow(
    "元局面",
  );
});

test("最初の合法手だけの探索と処理量計上でも合法手を失わない", () => {
  const state = createInitialState("doubles");
  for (const color of colors) {
    let work = 0;
    const first = getLegalPlacements(
      state,
      color,
      (cost = 1) => {
        work += cost;
      },
      true,
    );
    const all = getLegalPlacements(state, color);
    expect(first.map((entry) => entry.position)).toEqual(
      all.slice(0, 1).map((entry) => entry.position),
    );
    expect(work).toBeGreaterThan(1);
  }
});
