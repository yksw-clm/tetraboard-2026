import { expect, test } from "bun:test";
import { applyAction, getLegalActions } from "../src/index";
import type { FourShogiState, Side } from "../src/index";
import { fixture, move, position, succeeded } from "./helpers";

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

function renameIds(state: FourShogiState): FourShogiState {
  return {
    ...state,
    board: state.board.map((row) =>
      row.map((piece) => (piece === null ? null : { ...piece, id: piece.id + 1000 })),
    ),
    nextPieceId: state.nextPieceId + 1000,
    attackRelations: state.attackRelations.map((relation) => ({
      ...relation,
      targetPieceIds: relation.targetPieceIds.map((id) => id + 1000),
    })),
  };
}

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}で同じ局面の4回目に自動引き分けとなる`, () => {
    let state = fixture({ mode });
    for (let index = 0; index < 25; index++) {
      expect(state.status).toBe("playing");
      const [side, from, to] = cycle[index % cycle.length];
      state = succeeded(applyAction(state, side, move(from, to))).state;
      if (index < 24) expect(state.status).toBe("playing");
    }
    expect(state.status).toBe("finished");
    expect(state.result?.reason).toBe("repetition");
    expect(state.turn).toBeNull();
    expect(getLegalActions(state)).toEqual([]);
    expect(Math.max(...Object.values(state.repetitions))).toBe(4);
    if (state.result?.mode === "singles")
      expect(state.result.standings.map(({ rank }) => rank)).toEqual([1, 1, 1, 1]);
    if (state.result?.mode === "doubles") expect(state.result.winner).toBeNull();
  });
}

test("保存復元と内部IDの付け替えがあっても同じ回数で千日手になる", () => {
  let original = fixture();
  let renamed = renameIds(original);
  for (let index = 0; index < 25; index++) {
    const [side, from, to] = cycle[index % cycle.length];
    original = succeeded(applyAction(original, side, move(from, to))).state;
    renamed = succeeded(
      applyAction(JSON.parse(JSON.stringify(renamed)), side, move(from, to)),
    ).state;
    expect(renamed.repetitions).toEqual(original.repetitions);
    expect(renamed.result).toEqual(original.result);
    renamed = renameIds(renamed);
  }
  expect(original.result?.reason).toBe("repetition");
});

function historyState(): FourShogiState {
  return fixture({
    threePlayerAttackProhibited: true,
    pieces: [{ side: "north", kind: "silver", at: "E5", id: 200 }],
    attackRelations: [
      {
        attacker: "west",
        target: "north",
        reasons: ["threat", "capture"],
        targetPieceIds: [200, 9999],
        pendingSides: ["south", "north", "east"],
      },
    ],
    recaptureSquares: { east: [position("C4"), position("F6")] },
  });
}

test("履歴の対象駒対応と集合の順番を正規化し、捕獲済み標的のIDは比較しない", () => {
  const original = historyState();
  const swapped: FourShogiState = {
    ...renameIds(original),
    attackRelations: renameIds(original).attackRelations.map((relation) => ({
      ...relation,
      reasons: [...relation.reasons].reverse(),
      pendingSides: [...relation.pendingSides].reverse(),
      targetPieceIds: [1200, 123456],
    })),
    recaptureSquares: {
      ...original.recaptureSquares,
      east: [...original.recaptureSquares.east].reverse(),
    },
  };
  const left = succeeded(applyAction(original, "south", move("A9", "B9"))).state;
  const right = succeeded(applyAction(swapped, "south", move("A9", "B9"))).state;
  expect(right.repetitions).toEqual(left.repetitions);
  expect(getLegalActions(right)).toEqual(getLegalActions(left));
});

test("同じ盤面でも攻撃期限・取り返しマスが違えば別局面として記録する", () => {
  const original = historyState();
  const variants: FourShogiState[] = [
    {
      ...original,
      attackRelations: original.attackRelations.map((relation) => ({
        ...relation,
        pendingSides: ["south", "east"],
      })),
    },
    { ...original, recaptureSquares: { ...original.recaptureSquares, east: [position("C4")] } },
  ];
  const expected = succeeded(applyAction(original, "south", move("A9", "B9"))).state;
  for (const variant of variants) {
    const result = succeeded(applyAction(variant, "south", move("A9", "B9"))).state;
    expect(result.board).toEqual(expected.board);
    expect(result.turn).toBe(expected.turn);
    expect(result.repetitions).not.toEqual(expected.repetitions);
  }
});

test("OFF・ダブルス・脱落後は作用しない履歴を合法手と反復判定から除く", () => {
  const old = historyState();
  const variants: FourShogiState[] = [
    { ...old, threePlayerAttackProhibited: false },
    { ...old, mode: "doubles" },
    { ...old, eliminations: [{ side: "west", reason: "timeout", rank: 4, group: 1 }] },
  ];
  for (const state of variants) {
    const cleared: FourShogiState = {
      ...state,
      attackRelations: [],
      recaptureSquares: { south: [], west: [], north: [], east: [] },
    };
    expect(getLegalActions(state)).toEqual(getLegalActions(cleared));
    const left = succeeded(applyAction(state, "south", move("A9", "B9"))).state;
    const right = succeeded(applyAction(cleared, "south", move("A9", "B9"))).state;
    expect(left.repetitions).toEqual(right.repetitions);
    expect(left.attackRelations).toEqual([]);
    expect(left.recaptureSquares).toEqual({ south: [], west: [], north: [], east: [] });
  }
});

test("王手で同じ人の手番を飛ばし続けても、連続王手の千日手は引き分けにする", () => {
  let state = fixture({
    threePlayerAttackProhibited: true,
    kings: { west: "A5" },
    pieces: [{ side: "south", kind: "rook", at: "G3" }],
  });
  const opening = [
    ["south", "G3", "G1"],
    ["north", "I1", "I2"],
    ["east", "I9", "H9"],
  ] as const;
  for (const [side, from, to] of opening)
    state = succeeded(applyAction(state, side, move(from, to))).state;
  const checkingCycle = [
    ["south", "G1", "G2"],
    ["north", "I2", "I1"],
    ["east", "H9", "I9"],
    ["south", "G2", "G1"],
    ["north", "I1", "I2"],
    ["east", "I9", "H9"],
  ] as const;
  let steps = 0;
  while (state.status === "playing" && steps < 30) {
    const [side, from, to] = checkingCycle[steps % checkingCycle.length];
    expect(state.turn).toBe(side);
    expect(state.turn).not.toBe("west");
    state = succeeded(applyAction(state, side, move(from, to))).state;
    steps++;
  }
  expect(state.result?.reason).toBe("repetition");
  expect(
    state.attackRelations.find(
      (relation) => relation.attacker === "south" && relation.target === "north",
    )?.pendingSides,
  ).toContain("west");
});

test("千日手引き分けでも以前の脱落順位は保持する", () => {
  let state = fixture({ eliminations: [{ side: "west", reason: "left", rank: 4, group: 1 }] });
  const remaining = cycle.filter(([side]) => side !== "west");
  for (let index = 0; index < 19; index++) {
    const [side, from, to] = remaining[index % remaining.length] as readonly [Side, string, string];
    state = succeeded(applyAction(state, side, move(from, to))).state;
  }
  expect(state.result).toEqual({
    mode: "singles",
    reason: "repetition",
    standings: [
      { side: "south", rank: 1 },
      { side: "north", rank: 1 },
      { side: "east", rank: 1 },
      { side: "west", rank: 4 },
    ],
  });
});
