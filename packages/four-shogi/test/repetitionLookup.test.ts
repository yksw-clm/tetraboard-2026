import { expect, test } from "bun:test";
import {
  applyAction,
  chooseCpuAction,
  eliminateSide,
  getLegalActions,
  type FourShogiState,
} from "../src/index";
import { recordPosition } from "../src/repetition";
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

for (const mode of ["singles", "doubles"] as const) {
  for (const threePlayerAttackProhibited of [true, false]) {
    test(`${mode}/${threePlayerAttackProhibited}: キー参照と完全辞書で同じ4回目に千日手になる`, () => {
      let full = fixture({ mode, threePlayerAttackProhibited });
      let core = full;
      let history = { ...full.repetitions };
      for (let index = 0; index < 25; index++) {
        const [side, from, to] = cycle[index % cycle.length];
        full = succeeded(applyAction(full, side, move(from, to))).state;
        const next = succeeded(
          applyAction(
            { ...core, repetitions: {} },
            side,
            move(from, to),
            (key) => history[key] ?? 0,
          ),
        ).state;
        history = { ...history, ...next.repetitions };
        expect({ ...next, repetitions: history }).toEqual(full);
        core = next;
      }
      expect(full.result?.reason).toBe("repetition");
    });
  }
}

test("外部脱落で確定する局面も永続履歴を参照する", () => {
  const base = fixture();
  const first = succeeded(eliminateSide(base, "west", "left")).state;
  const [key] = Object.keys(first.repetitions);
  const full = { ...base, repetitions: { [key]: 3 } };
  const expected = succeeded(eliminateSide(full, "west", "left")).state;
  const actual = succeeded(
    eliminateSide(
      { ...base, repetitions: {} },
      "west",
      "left",
      (position) => full.repetitions[position] ?? 0,
    ),
  ).state;
  expect(actual).toEqual(expected);
  expect(actual.result?.reason).toBe("repetition");
});

test("同じキーを探索枝内で再記録すると基底履歴ではなく枝の回数を増やす", () => {
  const base = fixture();
  const history = () => 2;
  const once = recordPosition(base, history);
  const twice = recordPosition(once, history);
  const otherBranch = recordPosition(base, history);
  expect(Object.values(once.repetitions)).toEqual([3]);
  expect(Object.values(twice.repetitions)).toEqual([4]);
  expect(otherBranch).toEqual(once);
  expect(base.repetitions).toEqual({});
});

test("CPU探索は永続履歴の千日手を評価し、入力と他の探索枝を変更しない", () => {
  const base = fixture({
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "west", kind: "pawn", at: "C5" },
    ],
  });
  const repeated = succeeded(applyAction(base, "south", move("A9", "A8"))).state;
  const [key] = Object.keys(repeated.repetitions);
  const full: FourShogiState = { ...base, repetitions: { [key]: 3 } };
  const sparse = { ...base, repetitions: {} };
  const before = JSON.stringify(full);
  for (const level of [1, 2] as const) {
    expect(
      chooseCpuAction(
        sparse,
        level,
        () => 0.25,
        (position) => full.repetitions[position] ?? 0,
      ),
    ).toEqual(chooseCpuAction(full, level, () => 0.25));
  }
  expect(
    chooseCpuAction(
      sparse,
      2,
      () => 0.25,
      (position) => full.repetitions[position] ?? 0,
    ),
  ).toEqual(move("A9", "A8"));
  expect(JSON.stringify(full)).toBe(before);
  expect(sparse.repetitions).toEqual({});
});

test("CPU Lv2は応手の千日手も完全辞書と同じように評価する", () => {
  const base = fixture({
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "west", kind: "pawn", at: "C5" },
    ],
  });
  const history: Record<string, number> = {};
  const candidate = succeeded(applyAction(base, "south", move("E5", "C5"))).state;
  if (candidate.status !== "playing") throw new Error("Expected a reply");
  for (const reply of getLegalActions(candidate)) {
    const response = succeeded(applyAction(candidate, candidate.turn, reply)).state;
    for (const key of Object.keys(response.repetitions)) {
      if (!(key in candidate.repetitions)) history[key] = 3;
    }
  }
  expect(Object.keys(history).length).toBeGreaterThan(0);
  expect(
    chooseCpuAction(
      base,
      2,
      () => 0.25,
      (key) => history[key] ?? 0,
    ),
  ).toEqual(chooseCpuAction({ ...base, repetitions: history }, 2, () => 0.25));
  expect(base.repetitions).toEqual({});
});
