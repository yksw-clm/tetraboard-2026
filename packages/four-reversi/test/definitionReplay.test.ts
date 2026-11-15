import { expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  getLegalMoves,
  type FourReversiState,
} from "../src";
import { fourReversiDefinition as game, type FourReversiEvent } from "../src/definition";
import singlesNormal from "../../../test-fixtures/matches/reversi-singles-normal.json";
import singlesElimination from "../../../test-fixtures/matches/reversi-singles-elimination.json";
import doublesNormal from "../../../test-fixtures/matches/reversi-doubles-normal.json";
import doublesElimination from "../../../test-fixtures/matches/reversi-doubles-elimination.json";

for (const fixture of [singlesNormal, singlesElimination, doublesNormal, doublesElimination]) {
  test(`${fixture.name}: 全ステップの盤面・パス・結果が保存棋譜と既存関数に一致する`, () => {
    const saved = fixture.detail as {
      game: FourReversiState;
      replay: {
        initial: FourReversiState;
        steps: {
          action: Omit<FourReversiEvent, "passedColors">;
          passedColors: FourReversiEvent["passedColors"];
          game: FourReversiState;
        }[];
      };
    };
    const before = structuredClone(saved);
    const { initial, steps } = saved.replay;
    const events = steps.map(
      (s) => ({ ...s.action, passedColors: s.passedColors }) as FourReversiEvent,
    );
    const frames = game.replay(initial, events);
    expect(frames).toEqual(steps.map((s) => s.game));
    frames.forEach((state, index) => {
      const event = events[index]!;
      const previous = index === 0 ? initial : frames[index - 1]!;
      const expected =
        event.type === "place"
          ? applyAction(previous, { type: "placeStone", position: event.position })
          : eliminateColor(previous, event.color);
      if (!expected.ok) throw Error("Expected valid saved event");
      expect(state.board).toEqual(steps[index]!.game.board);
      expect(state).toEqual(expected.state);
      expect(game.rules.getResult(state)).toEqual(steps[index]!.game.result);
      expect(event.passedColors).toEqual(expected.passedColors);
    });
    expect(frames.at(-1)).toEqual(saved.game);
    expect(game.rules.getResult(frames.at(-1)!)).toEqual(saved.game.result);
    expect(saved).toEqual(before);
  });
}

test("再生は初期局面・手番・違法手・パス情報・重複脱落・終局後の破損を拒否する", () => {
  const initial = createInitialState("singles");
  const place: FourReversiEvent = {
    type: "place",
    color: "black",
    position: getLegalMoves(initial)[0]!,
    passedColors: [],
  };
  const drop: FourReversiEvent = {
    type: "eliminate",
    color: "black",
    reason: "left",
    passedColors: [],
  };
  expect(game.replay(initial, [])).toEqual([]);
  expect(() => game.replay({ ...initial, moveNumber: 1 }, [])).toThrow();
  expect(() => game.replay(initial, [{ ...place, color: "white" }])).toThrow();
  expect(() => game.replay(initial, [{ ...place, position: { x: 0, y: 0 } }])).toThrow();
  expect(() => game.replay(initial, [{ ...place, passedColors: ["white"] }])).toThrow();
  expect(() => game.replay(initial, [drop, drop])).toThrow();
  expect(() => game.replay(createInitialState("doubles"), [drop, place])).toThrow();
});
