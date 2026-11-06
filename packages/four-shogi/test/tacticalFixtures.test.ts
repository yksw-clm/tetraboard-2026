import { expect, test } from "bun:test";
import { tacticalCases } from "../bench/tactics";
import { positionForSide } from "../src/board";
import { applyAction, getActiveSides, getCheckState, getLegalActions } from "../src/index";
import { sides, type FourShogiAction } from "../src/types";

test("強制成りの重要局面は四方向とON/OFFで唯一の合法手が王手を解く成りになる", () => {
  const cases = tacticalCases().filter((entry) => entry.family === "forced-promotion");
  expect(cases).toHaveLength(8);
  expect(
    new Set(cases.map((entry) => `${entry.state.turn}:${entry.state.threePlayerAttackProhibited}`)),
  ).toEqual(new Set(sides.flatMap((side) => [false, true].map((rule) => `${side}:${rule}`))));
  for (const entry of cases) {
    const state = entry.state;
    const root = state.turn!;
    const expected: FourShogiAction = {
      type: "movePiece",
      from: positionForSide({ x: 4, y: 1 }, root),
      to: positionForSide({ x: 4, y: 0 }, root),
      promote: true,
    };
    expect(entry.criterion).toBe("promotion");
    expect(entry.critical).toBe(true);
    expect(getCheckState(state)[root]).toBe(true);
    expect(getLegalActions(state)).toEqual([expected]);

    expect(applyAction(state, root, { ...expected, promote: false }).ok).toBe(false);
    const result = applyAction(state, root, expected);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${entry.id}: 唯一の成りを適用できません`);
    expect(result.state.status).toBe("playing");
    expect(getActiveSides(result.state)).toContain(root);
    expect(getCheckState(result.state)[root]).toBe(false);
  }
});
