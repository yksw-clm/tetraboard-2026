import { expect, test } from "bun:test";
import { fourShogiDefinition as game } from "../src/definition";
import { applyAction, eliminateSide } from "../src";
import { fixture, move, succeeded } from "./helpers";

const cycle = [
  ["south", "A9", "B9"],
  ["west", "A1", "B1"],
  ["north", "I1", "H1"],
  ["east", "I9", "H9"],
  ["south", "B9", "A9"],
  ["west", "B1", "A1"],
  ["north", "H1", "I1"],
  ["east", "H9", "I9"],
] as const;

for (const mode of ["singles", "doubles"] as const)
  for (const threePlayerAttackProhibited of [true, false])
    test(`${mode}/${threePlayerAttackProhibited}: 履歴関数で完全辞書と同じ千日手になる`, () => {
      let full = fixture({ mode, threePlayerAttackProhibited });
      let sparse = full;
      const entries = new Map(Object.entries(full.repetitions));
      let calls = 0;
      for (let i = 0; i < 25; i++) {
        const [side, from, to] = cycle[i % cycle.length];
        const before = [...entries];
        full = succeeded(applyAction(full, side, move(from, to))).state;
        const actual = game.rules.applyAction(
          { ...sparse, repetitions: {} },
          side,
          move(from, to),
          (key) => {
            calls++;
            return entries.get(key) ?? 0;
          },
        );
        expect([...entries]).toEqual(before);
        if (!actual.ok) throw new Error(actual.reason.type);
        for (const [key, count] of Object.entries(actual.state.repetitions))
          entries.set(key, count);
        sparse = actual.state;
        expect({ ...sparse, repetitions: Object.fromEntries(entries) }).toEqual(full);
      }
      expect(calls).toBeGreaterThan(0);
      expect(game.rules.getResult(sparse)?.reason).toBe("repetition");
    });

test("外部脱落も履歴関数で千日手を判定する", () => {
  const base = fixture();
  const first = succeeded(eliminateSide(base, "west", "left")).state;
  const entries = Object.fromEntries(Object.keys(first.repetitions).map((key) => [key, 3]));
  const before = structuredClone(entries);
  const expected = succeeded(eliminateSide({ ...base, repetitions: entries }, "west", "left"));
  let calls = 0;
  const actual = game.rules.eliminateSeat(base, "west", "left", (key) => {
    calls++;
    return entries[key] ?? 0;
  });
  expect(actual.state).toEqual(expected.state);
  expect(actual.state.result?.reason).toBe("repetition");
  expect(entries).toEqual(before);
  expect(calls).toBeGreaterThan(0);
});
