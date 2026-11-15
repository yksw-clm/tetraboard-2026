import { expect, test } from "bun:test";
import type { EliminationReason } from "@tetraboard/game-contract";
import { gomokuCatalog } from "@tetraboard/gomoku/catalog";
import { gomokuDefinition as game, type GomokuEvent } from "@tetraboard/gomoku/definition";
import {
  applyAction,
  colors,
  createInitialState,
  eliminateColor,
  type GomokuAction,
  type GomokuState,
} from "../src";
import { chooseCpuMove } from "../src/cpu";
import { replayV1 } from "../src/replay";
import on from "../../../test-fixtures/matches/gomoku-on-five.json";
import off from "../../../test-fixtures/matches/gomoku-off-overline.json";

test("カタログと初期状態は既存の席・禁手の既定値を保つ", () => {
  expect(game.catalog).toBe(gomokuCatalog);
  expect(game.catalog.seats).toEqual(colors);
  expect(game.catalog).toEqual({
    id: "gomoku",
    seats: ["black", "white"],
    rating: "none",
    defaultSettings: { forbiddenRules: true },
  });
  for (const forbiddenRules of [true, false]) {
    const state = game.rules.createInitialState({ forbiddenRules });
    expect(state).toEqual(createInitialState(forbiddenRules));
    expect(game.rules.getTurn(state)).toBe("black");
    expect(game.rules.getResult(state)).toBeNull();
  }
});

test("着手の結果とイベントは既存の関数と一致し入力を変更しない", () => {
  const state = createInitialState();
  const action: GomokuAction = { type: "placeStone", position: { x: 7, y: 7 } };
  const before = structuredClone(state);
  const expected = applyAction(state, action);
  if (!expected.ok) throw new Error("Expected opening move");
  expect(game.rules.applyAction(state, "black", action)).toEqual({
    ...expected,
    event: { type: "place", color: "black", position: action.position },
  });
  expect(state).toEqual(before);
});

test("手番でない席の着手を拒否し、入力を変更しない", () => {
  const initial = createInitialState();
  const placed = applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } });
  if (!placed.ok) throw new Error("Expected opening move");
  const action: GomokuAction = { type: "placeStone", position: { x: 7, y: 8 } };
  for (const [state, seat] of [
    [initial, "white"],
    [placed.state, "black"],
  ] as const) {
    const before = structuredClone({ state, action });
    expect(applyAction(state, action).ok).toBe(true);
    expect(game.rules.applyAction(state, seat, action)).toEqual({
      ok: false,
      reason: { type: "not_your_turn" },
    });
    expect({ state, action }).toEqual(before);
  }
});

test.each([
  [
    ["double_three"],
    [
      [6, 7],
      [8, 7],
      [7, 6],
      [7, 8],
    ],
  ],
  [
    ["double_four"],
    [
      [5, 7],
      [6, 7],
      [8, 7],
      [7, 5],
      [7, 6],
      [7, 8],
    ],
  ],
  [
    ["overline"],
    [
      [3, 7],
      [4, 7],
      [5, 7],
      [6, 7],
      [8, 7],
    ],
  ],
  [
    ["double_three", "double_four"],
    [
      [6, 7],
      [8, 7],
      [7, 6],
      [7, 8],
      [5, 5],
      [6, 6],
      [8, 8],
      [5, 9],
      [6, 8],
      [8, 6],
    ],
  ],
] as const)("禁手 %j の種類をエラーコードへ変換せず返す", (patterns, stones) => {
  const state = createInitialState();
  const board = state.board.map((row) => [...row]);
  for (const [x, y] of stones) board[y][x] = "black";
  const input = { ...state, board };
  const before = structuredClone(input);
  const action: GomokuAction = { type: "placeStone", position: { x: 7, y: 7 } };
  const result = applyAction(input, action);
  if (result.ok || result.reason !== "forbidden") throw new Error("Expected forbidden move");
  expect(game.rules.applyAction(input, "black", action)).toEqual({
    ok: false,
    reason: { type: "forbidden", forbidden: result.forbidden },
  });
  expect([...result.forbidden].sort()).toEqual([...patterns].sort());
  expect(input).toEqual(before);
});

test("盤外・配置済み・終局後の拒否は既存の理由を保つ", () => {
  const state = createInitialState();
  const move: GomokuAction = { type: "placeStone", position: { x: 0, y: 0 } };
  const placed = applyAction(state, move);
  const finished = eliminateColor(state, "black");
  if (!placed.ok || !finished.ok) throw new Error("Expected valid transitions");
  for (const [input, seat, action] of [
    [state, "black", { type: "placeStone", position: { x: -1, y: 0 } }],
    [placed.state, "white", move],
    [finished.state, "white", move],
  ] as const) {
    const expected = applyAction(input, action);
    if (expected.ok || expected.reason === "forbidden")
      throw new Error("Expected non-forbidden rejection");
    expect(game.rules.applyAction(input, seat, action)).toEqual({
      ok: false,
      reason: { type: expected.reason },
    });
  }
});

test.each<EliminationReason>(["resigned", "left", "timeout", "disconnected"])(
  "脱落理由 %s をイベントへ含め、既存の終局結果を返す",
  (reason) => {
    for (const color of colors) {
      const state = createInitialState();
      const before = structuredClone(state);
      const expected = eliminateColor(state, color);
      if (!expected.ok) throw new Error("Expected elimination");
      const result = game.rules.eliminateSeat(state, color, reason);
      expect(result).toEqual({
        state: expected.state,
        event: { type: "eliminate", color, reason },
      });
      expect(game.rules.getTurn(result.state)).toBeNull();
      expect(game.rules.getResult(result.state)).toEqual(expected.state.result);
      expect(game.replay(state, [result.event])).toEqual([expected.state]);
      expect(state).toEqual(before);
    }
  },
);

test.each([1, 2] as const)("CPU Lv%i は同じ乱数で既存と同じ合法手を選ぶ", (level) => {
  for (const forbiddenRules of [true, false]) {
    const initial = createInitialState(forbiddenRules);
    const placed = applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } });
    if (!placed.ok) throw new Error("Expected opening move");
    for (const state of [initial, placed.state]) {
      if (state.status !== "playing") throw new Error("Expected playing state");
      const before = structuredClone(state);
      const random = () => 0.75;
      const position = chooseCpuMove(state, level, random);
      if (position === null) throw new Error("Expected legal CPU move");
      expect(game.cpu.chooseAction(state, state.turn, level, random)).toEqual({
        type: "placeStone",
        position,
      });
      expect(
        game.cpu.chooseAction(state, state.turn === "black" ? "white" : "black", level, random),
      ).toBeNull();
      expect(state).toEqual(before);
    }
    const finished = game.rules.eliminateSeat(initial, "black", "resigned").state;
    expect(game.cpu.chooseAction(finished, "white", level, () => 0)).toBeNull();
  }
});

test("CPUは合法手がないとき既存の関数と同じ null を返す", () => {
  const initial = createInitialState();
  const state = { ...initial, board: initial.board.map((row) => row.map(() => "black" as const)) };
  for (const level of [1, 2] as const) {
    expect(chooseCpuMove(state, level, () => 0)).toBeNull();
    expect(game.cpu.chooseAction(state, "black", level, () => 0)).toBeNull();
  }
});

for (const [name, fixture] of [
  ["禁手ONの五連", on],
  ["禁手OFFの長連", off],
] as const) {
  test(`固定棋譜 ${name} の全ステップと最終結果が一致する`, () => {
    // JSONの文字列を、依存を増やさずエンジンの公開型で照合します。
    const saved = fixture.detail as {
      game: Extract<GomokuState, { status: "finished" }>;
      replay: {
        initial: GomokuState;
        steps: { action: GomokuEvent; game: GomokuState }[];
      };
    };
    const replay = saved.replay;
    const before = structuredClone(replay);
    const frames = game.replay(
      replay.initial,
      replay.steps.map((step) => step.action),
    );
    expect(frames).toHaveLength(replay.steps.length);
    expect(frames).toEqual(replay.steps.map((step) => step.game));
    expect(frames).toEqual(replayV1(replay).slice(1));
    expect(frames.at(-1)).toEqual(saved.game);
    expect(game.rules.getResult(frames.at(-1)!)).toEqual(saved.game.result);
    expect(replay).toEqual(before);
  });
}

test("空のイベント列を再生でき、初期局面・手番・違法手・終局後の破損を拒否する", () => {
  const initial = createInitialState();
  const place: GomokuEvent = { type: "place", color: "black", position: { x: 0, y: 0 } };
  expect(game.replay(initial, [])).toEqual([]);
  expect(() => game.replay({ ...initial, moveNumber: 1 }, [])).toThrow();
  expect(() => game.replay(initial, [{ ...place, color: "white" }])).toThrow();
  expect(() => game.replay(initial, [place, { ...place, color: "white" }])).toThrow();
  expect(() =>
    game.replay(initial, [{ type: "eliminate", color: "black", reason: "left" }, place]),
  ).toThrow();
});
