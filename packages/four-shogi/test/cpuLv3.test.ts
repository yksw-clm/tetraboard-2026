import { expect, test } from "bun:test";
import { applyAction, createInitialState, type FourShogiState } from "../src/index";
import { chooseLv3Action } from "../src/cpuLv3";
import { lv3Fixtures as fixtures } from "../bench/lv3Fixtures";
for (const fixture of fixtures.slice(0, 3)) {
  test(`${fixture.id}: 本番で確認したただ取り・取り返し不能・高額な合駒を避けます`, () => {
    const state = fixture.state as FourShogiState,
      before = JSON.stringify(state);
    const result = chooseLv3Action(state);
    expect(result.action).not.toEqual(fixture.avoid);
    expect(result.stats.safetyComplete).toBe(true);
    expect(applyAction(state, state.turn!, result.action!).ok).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  }, 10000);
}
test("独立した30局面で予算を守り、両ルールで合法手を返します", () => {
  for (const fixture of fixtures)
    for (const restricted of [true, false]) {
      const state = { ...fixture.state, threePlayerAttackProhibited: restricted } as FourShogiState;
      const result = chooseLv3Action(state, { maxWork: 128 });
      expect(result.stats.work).toBeLessThanOrEqual(128);
      expect(applyAction(state, state.turn!, result.action!).ok).toBe(true);
    }
});
test("決定的な結果・途中結果・不正な予算と未対応モードを検証します", () => {
  const state = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
  });
  const progress: unknown[] = [];
  const result = chooseLv3Action(state, { maxWork: 128, onProgress: (r) => progress.push(r) });
  expect(result).toEqual(chooseLv3Action(state, { maxWork: 128 }));
  expect(progress.length).toBeGreaterThan(0);
  expect(() => chooseLv3Action(state, { maxWork: NaN })).toThrow();
  expect(() => chooseLv3Action({ ...state, mode: "doubles" })).toThrow("singles");
});
