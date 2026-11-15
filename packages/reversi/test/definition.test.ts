import { expect, test } from "bun:test";
import type { EliminationReason } from "@tetraboard/game-contract";
import {
  applyAction,
  chooseCpuMove,
  createInitialState,
  eliminateColor,
  type ReversiState,
  type ReversiAction,
} from "../src";
import { reversiDefinition as game, type ReversiEvent } from "../src/definition";
import { reversiCatalog } from "../src/catalog";
import archive from "../../../test-fixtures/matches/reversi-standard-draw.json";

test("初期局面とEloのカタログを公開する", () => {
  expect(game.catalog).toBe(reversiCatalog);
  expect(game.catalog.rating).toBe("elo");
  expect(game.rules.createInitialState({})).toEqual(createInitialState());
  expect(game.rules.getTurn(createInitialState())).toBe("black");
  expect(game.rules.getResult(createInitialState())).toBeNull();
});

test("着手・不正な手・手番外の拒否と入力不変", () => {
  const state = createInitialState();
  const before = structuredClone(state);
  for (const position of [
    { x: 3, y: 2 },
    { x: -1, y: 0 },
    { x: 8, y: 0 },
    { x: 0.5, y: 0 },
    { x: 3, y: 3 },
    { x: 0, y: 0 },
  ]) {
    const action: ReversiAction = { type: "placeStone", position };
    const expected = applyAction(state, action);
    const result = game.rules.applyAction(state, "black", action);
    expect(result).toEqual(
      expected.ok
        ? {
            ok: true,
            state: expected.state,
            event: { type: "place", color: "black", position, passedColors: expected.passedColors },
          }
        : { ok: false, reason: { type: expected.reason } },
    );
    expect(game.rules.applyAction(state, "white", action)).toEqual({
      ok: false,
      reason: { type: "not_your_turn" },
    });
  }
  expect(state).toEqual(before);
});

test.each([
  ["KW.KW...", ["white"], null],
  ["KW......", ["white", "black"], "all_passed"],
] as const)("自動パス %s は既存と同じ状態・パス・終局結果を返す", (row, passed, reason) => {
  const state: ReversiState = {
    ...createInitialState(),
    board: [row, ...Array<string>(7).fill("........")].map((r) =>
      [...r].map((c) => (c === "K" ? "black" : c === "W" ? "white" : null)),
    ),
  };
  const action: ReversiAction = { type: "placeStone", position: { x: 2, y: 0 } };
  const expected = applyAction(state, action);
  const result = game.rules.applyAction(state, "black", action);
  if (!result.ok || !expected.ok) throw Error("Expected move");
  expect(result.state).toEqual(expected.state);
  expect(result.event.passedColors).toEqual(passed);
  expect(game.rules.getResult(result.state)?.reason ?? null).toBe(reason);
  if (!reason) expect(result.state.turn).toBe("black");
});

test.each<EliminationReason>(["resigned", "left", "timeout", "disconnected"])(
  "脱落 %s は既存の勝敗を保ち再生できる",
  (reason) => {
    for (const color of game.catalog.seats) {
      const state = createInitialState();
      const before = structuredClone(state);
      const expected = eliminateColor(state, color);
      if (!expected.ok) throw Error("Expected elimination");
      const result = game.rules.eliminateSeat(state, color, reason);
      expect(result).toEqual({
        state: expected.state,
        event: { type: "eliminate", color, reason, passedColors: expected.passedColors },
      });
      expect(game.rules.getResult(result.state)).toEqual(expected.state.result);
      expect(game.rules.getTurn(result.state)).toBeNull();
      expect(game.replay(state, [result.event])).toEqual([result.state]);
      expect(
        game.rules.applyAction(result.state, color, {
          type: "placeStone",
          position: { x: 3, y: 2 },
        }),
      ).toEqual({ ok: false, reason: { type: "game_finished" } });
      expect(state).toEqual(before);
    }
  },
);

test.each([1, 2] as const)("CPU Lv%d は既存と同じ選択をする", (level) => {
  const state = createInitialState();
  const before = structuredClone(state);
  const position = chooseCpuMove(state, level, () => 0.75);
  if (position === null) throw Error("Expected legal move");
  expect(game.cpu.chooseAction(state, "black", level, () => 0.75)).toEqual({
    type: "placeStone",
    position,
  });
  expect(game.cpu.chooseAction(state, "white", level, () => 0)).toBeNull();
  const finished = game.rules.eliminateSeat(state, "black", "timeout").state;
  expect(game.cpu.chooseAction(finished, "white", level, () => 0)).toBeNull();
  const noMoves = { ...state, board: state.board.map((row) => row.map(() => "black" as const)) };
  expect(chooseCpuMove(noMoves, level)).toBeNull();
  expect(game.cpu.chooseAction(noMoves, "black", level, () => 0)).toBeNull();
  expect(state).toEqual(before);
});

test("通常リバーシの固定棋譜の全60ステップと最終結果が一致する", () => {
  const saved = archive.detail as {
    game: ReversiState;
    replay: {
      initial: ReversiState;
      steps: {
        action: Omit<ReversiEvent, "passedColors">;
        passedColors: ReversiEvent["passedColors"];
        game: ReversiState;
      }[];
    };
  };
  const before = structuredClone(saved);
  const events = saved.replay.steps.map(
    (step) => ({ ...step.action, passedColors: step.passedColors }) as ReversiEvent,
  );
  const frames = game.replay(saved.replay.initial, events);
  expect(frames).toEqual(saved.replay.steps.map((s) => s.game));
  expect(frames.at(-1)).toEqual(saved.game);
  expect(game.rules.getResult(frames.at(-1)!)).toEqual(saved.game.result);
  expect(saved).toEqual(before);
});

test("再生は初期状態・手番・違法手・パス情報・終局後の破損を拒否する", () => {
  const initial = createInitialState();
  const place: ReversiEvent = {
    type: "place",
    color: "black",
    position: { x: 3, y: 2 },
    passedColors: [],
  };
  expect(game.replay(initial, [])).toEqual([]);
  expect(() => game.replay({ ...initial, moveNumber: 1 }, [])).toThrow();
  expect(() => game.replay(initial, [{ ...place, color: "white" }])).toThrow();
  expect(() => game.replay(initial, [{ ...place, position: { x: 0, y: 0 } }])).toThrow();
  expect(() => game.replay(initial, [{ ...place, passedColors: ["white"] }])).toThrow();
  expect(() =>
    game.replay(initial, [
      { type: "eliminate", color: "black", reason: "left", passedColors: [] },
      place,
    ]),
  ).toThrow();
});
