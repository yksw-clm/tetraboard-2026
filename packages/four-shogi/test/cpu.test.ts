import { expect, test } from "bun:test";
import {
  applyAction,
  chooseCpuAction,
  createInitialState,
  eliminateSide,
  getCheckState,
  getLegalActions,
} from "../src/index";
import type { CpuLevel, FourShogiAction, FourShogiState } from "../src/index";
import { drop, fixture, move, position, succeeded } from "./helpers";

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function chosen(state: FourShogiState, level: CpuLevel = 2): FourShogiAction {
  const action = chooseCpuAction(state, level, () => 0);
  expect(action).not.toBeNull();
  if (action === null) throw new Error("Expected the CPU to choose a legal action");
  expect(getLegalActions(state)).toContainEqual(action);
  return action;
}

test("Lv1は注入した乱数で合法手列の先頭と末尾を選ぶ", () => {
  const state = fixture({
    pieces: [{ side: "south", kind: "silver", at: "E3" }],
    hands: { south: { pawn: 1 } },
  });
  const actions = getLegalActions(state);
  expect(chooseCpuAction(state, 1, () => 0)).toEqual(actions[0]);
  expect(chooseCpuAction(state, 1, () => 0.999999)).toEqual(actions.at(-1)!);
});

for (const action of [move("E3", "D2"), move("E3", "D2", true), drop("pawn", "E5")]) {
  test(`Lv1の選択対象には移動・成り・打ちを含む: ${JSON.stringify(action)}`, () => {
    const state = fixture({
      pieces: [{ side: "south", kind: "silver", at: "E3" }],
      hands: { south: { pawn: 1 } },
    });
    const actions = getLegalActions(state);
    const index = actions.findIndex(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(action),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(chooseCpuAction(state, 1, () => (index + 0.5) / actions.length)).toEqual(action);
  });
}

test("Lv1は有限の範囲外乱数を先頭・末尾へ丸める", () => {
  const state = fixture();
  const actions = getLegalActions(state);
  expect(chooseCpuAction(state, 1, () => -1)).toEqual(actions[0]);
  expect(chooseCpuAction(state, 1, () => 1)).toEqual(actions.at(-1)!);
});

test("Lv1は非有限の乱数をTypeErrorで拒否し、入力状態を変えない", () => {
  const state = freezeDeep(fixture());
  const before = structuredClone(state);
  for (const sample of [NaN, Infinity, -Infinity]) {
    expect(() => chooseCpuAction(state, 1, () => sample)).toThrow(TypeError);
  }
  expect(state).toEqual(before);
});

for (const level of [1, 2] as const) {
  test(`Lv${level}は終局済み状態にnullを返す`, () => {
    let state = fixture();
    for (const side of ["west", "north", "east"] as const) {
      state = succeeded(eliminateSide(state, side, "left")).state;
    }
    expect(state.status).toBe("finished");
    expect(chooseCpuAction(state, level, () => 0)).toBeNull();
  });

  test(`Lv${level}は王手なしでも合法手0件ならnullを返す`, () => {
    const state = fixture({
      kings: { north: "H2", east: "H7" },
      pieces: [
        { side: "west", kind: "rook", at: "B1" },
        { side: "north", kind: "rook", at: "I8" },
      ],
    });
    expect(getCheckState(state).south).toBe(false);
    expect(getLegalActions(state)).toEqual([]);
    expect(chooseCpuAction(state, level, () => 0)).toBeNull();
  });

  for (const restriction of [true, false]) {
    test(`Lv${level}は初期局面の三人攻撃設定${restriction}でもエンジンが受理する手を返す`, () => {
      const state = createInitialState({
        mode: "singles",
        players: { south: "s", west: "w", north: "n", east: "e" },
        threePlayerAttackProhibited: restriction,
      });
      const action = chosen(state, level);
      expect(applyAction(state, "south", action).ok).toBe(true);
    });
  }

  test(`Lv${level}は深く凍結した履歴付き状態を変えず、JSON復元後も同じ手を選ぶ`, () => {
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
      ],
      recaptureSquares: { south: [position("F3")] },
    });
    const before = structuredClone(state);
    const restored: FourShogiState = JSON.parse(JSON.stringify(state));
    const action = chooseCpuAction(freezeDeep(state), level, () => 0.35);
    expect(action).not.toBeNull();
    if (action === null) throw new Error("Expected a legal action after freezing the state");
    expect(getLegalActions(state)).toContainEqual(action);
    expect(chooseCpuAction(restored, level, () => 0.35)).toEqual(action);
    expect(state).toEqual(before);
    expect(restored).toEqual(before);
  });
}

test("Lv2の評価が同点なら元の合法手列の先頭を選び、乱数に依存しない", () => {
  const state = fixture();
  const expected = getLegalActions(state)[0];
  expect(chooseCpuAction(state, 2, () => 0)).toEqual(expected);
  expect(chooseCpuAction(state, 2, () => 0.999999)).toEqual(expected);
  expect(
    chooseCpuAction(state, 2, () => {
      throw new Error("Lv2 must not sample randomness");
    }),
  ).toEqual(expected);
});

test("Lv2は安全に取れる歩より高価な飛車を捕獲する", () => {
  const state = fixture({
    pieces: [
      { side: "south", kind: "silver", at: "E5" },
      { side: "west", kind: "pawn", at: "D4" },
      { side: "west", kind: "rook", at: "F4" },
    ],
  });
  expect(getLegalActions(state)).toContainEqual(move("E5", "D4"));
  const action = chosen(state);
  expect(action).toEqual(move("E5", "F4"));
  expect(succeeded(applyAction(state, "south", action)).state.hands.south.rook).toBe(1);
});

test("Lv2は金取り後に飛車を取り返される誘惑手を避け、安全な歩取りと成りを選ぶ", () => {
  const state = fixture({
    kings: { north: "I2" },
    pieces: [
      { side: "south", kind: "rook", at: "E5" },
      { side: "west", kind: "gold", at: "D5" },
      { side: "west", kind: "pawn", at: "E3" },
      { side: "west", kind: "rook", at: "D1" },
    ],
  });
  const tempting = succeeded(applyAction(state, "south", move("E5", "D5")));
  expect(tempting.state.turn).toBe("west");
  expect(getLegalActions(tempting.state)).toContainEqual(move("D1", "D5"));
  expect(chosen(state)).toEqual(move("E5", "E3", true));
});

test("Lv2は安全に成れる歩をと金にする", () => {
  const state = fixture({ pieces: [{ side: "south", kind: "pawn", at: "E4" }] });
  expect(getLegalActions(state)).toContainEqual(move("E4", "E3"));
  const action = chosen(state);
  expect(action).toEqual(move("E4", "E3", true));
  expect(succeeded(applyAction(state, "south", action)).state.board[2][4]?.promoted).toBe(true);
});

test("Lv2は王手への応手に合駒しかなければ持ち駒を打って守る", () => {
  const state = fixture({
    kings: { south: "E9", north: "I2", east: "I7" },
    pieces: [
      { side: "west", kind: "rook", at: "E1" },
      { side: "south", kind: "pawn", at: "D8" },
      { side: "south", kind: "pawn", at: "F8" },
      { side: "south", kind: "rook", at: "D9" },
      { side: "south", kind: "rook", at: "F9" },
    ],
    hands: { south: { gold: 1 } },
  });
  expect(getCheckState(state).south).toBe(true);
  expect(getLegalActions(state).every((action) => action.type === "dropPiece")).toBe(true);
  const action = chosen(state);
  expect(action.type).toBe("dropPiece");
  expect(getCheckState(succeeded(applyAction(state, "south", action)).state).south).toBe(false);
});

test("Lv2は駒の損得が同じなら敵の利きが周囲から外れる王の退避を選ぶ", () => {
  const state = fixture({
    kings: { south: "D5" },
    pieces: [{ side: "north", kind: "rook", at: "G4" }],
  });
  expect(getLegalActions(state)).toContainEqual(move("D5", "C5"));
  expect(chosen(state)).toEqual(move("D5", "C6"));
});

for (const restriction of [true, false]) {
  test(`Lv2は攻撃履歴による捕獲禁止を三人攻撃設定${restriction}に従って扱う`, () => {
    const state = fixture({
      threePlayerAttackProhibited: restriction,
      kings: { north: "I2" },
      pieces: [
        { side: "south", kind: "pawn", at: "D4" },
        { side: "west", kind: "rook", at: "D3" },
      ],
      attackRelations: [
        {
          attacker: "north",
          target: "west",
          reasons: ["check"],
          targetPieceIds: [],
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
    });
    const action = chosen(state);
    if (restriction) {
      expect(action).not.toEqual(move("D4", "D3", true));
      expect(action).not.toEqual(move("D4", "D3"));
    } else {
      expect(action).toEqual(move("D4", "D3", true));
    }
    expect(applyAction(state, "south", action).ok).toBe(true);
  });
}

test("Lv2は飛車を取れる手より、その一手で最後の相手を詰ませる勝利を選ぶ", () => {
  const state = fixture({
    kings: { west: "E1" },
    pieces: [
      { side: "south", kind: "rook", at: "D3" },
      { side: "south", kind: "rook", at: "F3" },
      { side: "south", kind: "silver", at: "E3" },
      { side: "south", kind: "rook", at: "G2" },
      { side: "west", kind: "rook", at: "G5" },
    ],
    eliminations: [
      { side: "north", reason: "left", rank: 4, group: 1 },
      { side: "east", reason: "left", rank: 3, group: 2 },
    ],
  });
  expect(getLegalActions(state)).toContainEqual(move("G2", "G5"));
  const action = chosen(state);
  const result = succeeded(applyAction(state, "south", action));
  expect(result.state.status).toBe("finished");
  if (result.state.result?.mode !== "singles") throw new Error("Expected a singles result");
  expect(result.state.result.standings).toContainEqual({ side: "south", rank: 1 });
  expect(
    result.eliminations.some((entry) => entry.side === "west" && entry.reason === "checkmate"),
  ).toBe(true);
});

for (const mode of ["singles", "doubles"] as const) {
  for (const restriction of [true, false]) {
    test(`Lv2は持ち駒が多い${mode}・三人攻撃設定${restriction}でも入力を変えず合法手を返す`, () => {
      const hand = { rook: 1, gold: 2, silver: 2, pawn: 3 };
      const state = fixture({
        mode,
        threePlayerAttackProhibited: restriction,
        hands: { south: hand, west: hand, north: hand, east: hand },
      });
      const before = JSON.stringify(state);
      const action = chosen(state);
      expect(applyAction(state, "south", action).ok).toBe(true);
      expect(JSON.stringify(state)).toBe(before);
    });
  }
}

test("Lv2は持ち駒が多く三人攻撃の履歴もある局面で合法手を返し、入力履歴を変えない", () => {
  const hand = { rook: 1, gold: 2, silver: 2, pawn: 3 };
  const state = fixture({
    threePlayerAttackProhibited: true,
    hands: { south: hand, west: hand, north: hand, east: hand },
    attackRelations: [
      {
        attacker: "north",
        target: "west",
        reasons: ["check"],
        targetPieceIds: [],
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
  });
  const before = JSON.stringify(state);
  const action = chosen(state);
  expect(applyAction(state, "south", action).ok).toBe(true);
  expect(JSON.stringify(state)).toBe(before);
});
