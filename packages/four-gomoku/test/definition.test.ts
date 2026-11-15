import { expect, test } from "bun:test";
import type { EliminationReason } from "@tetraboard/game-contract";
import { fourGomokuCatalog } from "@tetraboard/four-gomoku/catalog";
import {
  fourGomokuDefinition as game,
  type FourGomokuAction,
  type FourGomokuEvent,
} from "@tetraboard/four-gomoku/definition";
import {
  applyAction,
  colors,
  createInitialState,
  eliminateColor,
  type FourGomokuState,
} from "../src";
import { chooseCpuMove } from "../src/cpu";
import { replayV1, sameState } from "../src/replay";
import ranked from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import full from "../../../test-fixtures/matches/four-gomoku-singles-full.json";
import mixed from "../../../test-fixtures/matches/four-gomoku-doubles-mixed.json";
import eliminated from "../../../test-fixtures/matches/four-gomoku-doubles-elimination.json";

test("4色・レートなし・シングルス既定のカタログと両モードの初期状態", () => {
  expect(game.catalog).toBe(fourGomokuCatalog);
  expect(game.catalog).toEqual({
    id: "four-gomoku",
    seats: colors,
    rating: "none",
    defaultSettings: { mode: "singles" },
  });
  for (const mode of ["singles", "doubles"] as const) {
    const state = game.rules.createInitialState({ mode });
    expect(state).toEqual(createInitialState(mode));
    expect(game.rules.getTurn(state)).toBe("black");
    expect(game.rules.getResult(state)).toBeNull();
  }
});

test("着手・盤外・配置済みの結果は既存と一致し、手番外を拒否して入力を保つ", () => {
  for (const mode of ["singles", "doubles"] as const) {
    const initial = createInitialState(mode);
    const placed = applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } });
    if (!placed.ok) throw Error("Expected placement");
    for (const state of [initial, placed.state]) {
      if (state.status !== "playing") throw Error("Expected playing");
      const before = structuredClone(state);
      for (const position of [
        { x: 7, y: 7 },
        { x: 8, y: 7 },
        { x: -1, y: 0 },
        { x: 15, y: 0 },
        { x: 0.5, y: 0 },
      ]) {
        const action: FourGomokuAction = { type: "placeStone", position };
        const expected = applyAction(state, action);
        expect(game.rules.applyAction(state, state.turn, action)).toEqual(
          expected.ok
            ? { ...expected, event: { type: "place", color: state.turn, position } }
            : { ok: false, reason: { type: expected.reason } },
        );
        for (const color of colors.filter((c) => c !== state.turn))
          expect(game.rules.applyAction(state, color, action)).toEqual({
            ok: false,
            reason: { type: "not_your_turn" },
          });
      }
      expect(state).toEqual(before);
    }
  }
});

test.each<EliminationReason>(["resigned", "left", "timeout", "disconnected"])(
  "両モードの脱落 %s は既存と同じ順位・チームを返し再生できる",
  (reason) => {
    for (const mode of ["singles", "doubles"] as const) {
      for (const first of colors) {
        const initial = createInitialState(mode);
        let state = initial;
        const events: FourGomokuEvent[] = [];
        const frames: FourGomokuState[] = [];
        for (const color of [first, ...colors.filter((c) => c !== first)]) {
          if (state.status === "finished") break;
          const before = structuredClone(state);
          const expected = eliminateColor(state, color, reason);
          if (!expected.ok) throw Error("Expected elimination");
          const result = game.rules.eliminateSeat(state, color, reason);
          expect(result).toEqual({
            state: expected.state,
            event: { type: "eliminate", color, reason },
          });
          expect(state).toEqual(before);
          state = result.state;
          events.push(result.event);
          frames.push(state);
          expect(game.rules.getResult(state)).toEqual(expected.state.result);
          expect(game.rules.getTurn(state)).toBe(expected.state.turn);
        }
        expect(state.status).toBe("finished");
        expect(game.replay(initial, events)).toEqual(frames);
        expect(
          game.rules.applyAction(state, first, { type: "placeStone", position: { x: 7, y: 7 } }),
        ).toEqual({ ok: false, reason: { type: "game_finished" } });
        expect(() => game.rules.eliminateSeat(state, first, reason)).toThrow();
      }
    }
  },
);

test.each([1, 2] as const)("CPU Lv%d は同じ乱数で既存と同じ手を選ぶ", (level) => {
  for (const mode of ["singles", "doubles"] as const) {
    const initial = createInitialState(mode);
    const moved = applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } });
    if (!moved.ok) throw Error("Expected placement");
    for (const state of [initial, moved.state]) {
      if (state.status !== "playing") throw Error("Expected playing");
      const before = structuredClone(state);
      const position = chooseCpuMove(state, level, () => 0.75);
      if (position === null) throw Error("Expected legal move");
      expect(game.cpu.chooseAction(state, state.turn, level, () => 0.75)).toEqual({
        type: "placeStone",
        position,
      });
      for (const color of colors.filter((c) => c !== state.turn))
        expect(game.cpu.chooseAction(state, color, level, () => 0.75)).toBeNull();
      expect(state).toEqual(before);
    }
    const noMoves = {
      ...initial,
      board: initial.board.map((row) => row.map(() => "black" as const)),
    };
    expect(chooseCpuMove(noMoves, level)).toBeNull();
    expect(game.cpu.chooseAction(noMoves, "black", level, () => 0)).toBeNull();
  }
  const finished = game.rules.eliminateSeat(
    createInitialState("doubles"),
    "black",
    "resigned",
  ).state;
  expect(game.cpu.chooseAction(finished, "white", level, () => 0)).toBeNull();
});

for (const [name, fixture] of [
  ["順位", ranked],
  ["満盤", full],
  ["混色", mixed],
  ["チーム脱落", eliminated],
] as const) {
  test(`固定棋譜 ${name} の全ステップ・既存再生・最終結果が一致する`, () => {
    const saved = JSON.parse(fixture.recordJson) as {
      game: FourGomokuState;
      replay: {
        initial: FourGomokuState;
        steps: { action: FourGomokuEvent; game: FourGomokuState }[];
      };
    };
    const before = structuredClone(saved);
    const { initial, steps } = saved.replay;
    const frames = game.replay(
      initial,
      steps.map((s) => s.action),
    );
    expect(frames).toHaveLength(steps.length);
    expect(frames).toEqual(replayV1(saved.replay).slice(1));
    frames.forEach((state, index) => {
      // 保存済み棋譜には表示用の lastMoves がないため、規則版1の全状態で照合します。
      expect(sameState(state, steps[index]!.game)).toBe(true);
      expect(state.board).toEqual(steps[index]!.game.board);
      expect(game.rules.getResult(state)).toEqual(steps[index]!.game.result);
      const event = steps[index]!.action;
      if (event.type === "place") {
        const input = index === 0 ? initial : frames[index - 1]!;
        const expected = applyAction(input, { type: "placeStone", position: event.position });
        expect(expected.ok && expected.state).toEqual(state);
      }
    });
    expect(sameState(frames.at(-1)!, saved.game)).toBe(true);
    expect(game.rules.getResult(frames.at(-1)!)).toEqual(saved.game.result);
    expect(saved).toEqual(before);
  });
}

test("再生は空列を許し、初期局面・手番・違法手・重複脱落・終局後の破損を拒否する", () => {
  const initial = createInitialState();
  const place: FourGomokuEvent = { type: "place", color: "black", position: { x: 0, y: 0 } };
  const drop: FourGomokuEvent = { type: "eliminate", color: "black", reason: "left" };
  expect(game.replay(initial, [])).toEqual([]);
  expect(() => game.replay({ ...initial, moveNumber: 1 }, [])).toThrow();
  expect(() => game.replay(initial, [{ ...place, color: "white" }])).toThrow();
  expect(() => game.replay(initial, [{ ...place, position: { x: -1, y: 0 } }])).toThrow();
  expect(() => game.replay(initial, [place, { ...place, color: "white" }])).toThrow();
  expect(() => game.replay(initial, [drop, drop])).toThrow();
  expect(() => game.replay(createInitialState("doubles"), [drop, place])).toThrow();
});
