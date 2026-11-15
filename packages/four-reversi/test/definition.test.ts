import { expect, test } from "bun:test";
import type { EliminationReason } from "@tetraboard/game-contract";
import {
  applyAction,
  chooseCpuMove,
  colors,
  createInitialState,
  eliminateColor,
  getLegalMoves,
  type FourReversiAction,
  type FourReversiState,
} from "../src";
import { fourReversiDefinition as game, type FourReversiEvent } from "../src/definition";
import { fourReversiCatalog } from "../src/catalog";

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}: 初期局面・skill・設定と着手・拒否は既存と一致する`, () => {
    expect(game.catalog).toBe(fourReversiCatalog);
    expect(game.catalog.rating).toBe("skill");
    const initial = createInitialState(mode);
    expect(game.rules.createInitialState({ mode })).toEqual(initial);
    expect(game.rules.getResult(initial)).toBeNull();
    expect(game.rules.getTurn(initial)).toBe("black");
    const before = structuredClone(initial);
    for (const position of [
      ...getLegalMoves(initial),
      { x: -1, y: 0 },
      { x: 8, y: 0 },
      { x: 0.5, y: 0 },
      { x: 3, y: 3 },
      { x: 0, y: 0 },
    ]) {
      const action: FourReversiAction = { type: "placeStone", position };
      const expected = applyAction(initial, action);
      expect(game.rules.applyAction(initial, "black", action)).toEqual(
        expected.ok
          ? {
              ok: true,
              state: expected.state,
              event: {
                type: "place",
                color: "black",
                position,
                passedColors: expected.passedColors,
              },
            }
          : { ok: false, reason: { type: expected.reason } },
      );
      for (const color of colors.filter((c) => c !== "black"))
        expect(game.rules.applyAction(initial, color, action)).toEqual({
          ok: false,
          reason: { type: "not_your_turn" },
        });
    }
    expect(initial).toEqual(before);
  });
}

test.each<EliminationReason>(["resigned", "left", "timeout", "disconnected"])(
  "両モードの全席の脱落 %s は既存と同じ結果で再生できる",
  (reason) => {
    for (const mode of ["singles", "doubles"] as const)
      for (const first of colors) {
        const initial = createInitialState(mode);
        let state = initial;
        const events: FourReversiEvent[] = [];
        const frames: FourReversiState[] = [];
        for (const color of [first, ...colors.filter((c) => c !== first)]) {
          if (state.status === "finished") break;
          const before = structuredClone(state);
          const expected = eliminateColor(state, color);
          if (!expected.ok) throw Error("Expected elimination");
          const result = game.rules.eliminateSeat(state, color, reason);
          expect(result).toEqual({
            state: expected.state,
            event: { type: "eliminate", color, reason, passedColors: expected.passedColors },
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
          game.rules.applyAction(state, first, { type: "placeStone", position: { x: 0, y: 0 } }),
        ).toEqual({
          ok: false,
          reason: { type: "game_finished" },
        });
        expect(() => game.rules.eliminateSeat(state, first, reason)).toThrow();
      }
  },
);

test.each([1, 2] as const)("CPU Lv%d は同じ乱数で既存と同じ選択をする", (level) => {
  for (const mode of ["singles", "doubles"] as const) {
    const initial = createInitialState(mode);
    const moved = applyAction(initial, {
      type: "placeStone",
      position: getLegalMoves(initial)[0]!,
    });
    if (!moved.ok) throw Error("Expected move");
    for (const state of [initial, moved.state]) {
      if (state.status !== "playing") throw Error("Expected playing");
      const before = structuredClone(state);
      const position = chooseCpuMove(state, level, () => 0.75);
      expect(game.cpu.chooseAction(state, state.turn, level, () => 0.75)).toEqual(
        position ? { type: "placeStone", position } : null,
      );
      for (const color of colors.filter((c) => c !== state.turn))
        expect(game.cpu.chooseAction(state, color, level, () => 0)).toBeNull();
      expect(state).toEqual(before);
    }
    const noMoves = { ...initial, board: initial.board.map((r) => r.map(() => "black" as const)) };
    expect(game.cpu.chooseAction(noMoves, "black", level, () => 0)).toBeNull();
  }
  const finished = game.rules.eliminateSeat(createInitialState("doubles"), "black", "left").state;
  expect(game.cpu.chooseAction(finished, "white", level, () => 0)).toBeNull();
});

test("複数色の自動パスと入力不変は既存と同じ", () => {
  const cells = { K: "black", W: "white", R: "red", B: "blue", ".": null } as const;
  const state: FourReversiState = {
    ...createInitialState("singles"),
    board: ["KW......", "BK......", ...Array<string>(5).fill("........"), "......RW"].map((row) =>
      [...row].map((c) => cells[c as keyof typeof cells]),
    ),
    consecutivePasses: ["red", "blue"],
  };
  const before = structuredClone(state);
  const action = { type: "placeStone", position: { x: 2, y: 0 } } as const;
  const expected = applyAction(state, action);
  const result = game.rules.applyAction(state, "black", action);
  if (!result.ok || !expected.ok) throw Error("Expected move");
  expect(result.state).toEqual(expected.state);
  expect(result.event.passedColors).toEqual(["white", "red"]);
  expect(state).toEqual(before);
});
