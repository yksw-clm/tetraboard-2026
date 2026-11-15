import { expect, test } from "bun:test";
import { fourShogiDefinition as game } from "../src/definition";
import {
  createInitialState,
  getLegalActions,
  type InitialStateOptions,
  type FourShogiState,
} from "../src";
import { applyReplayEvent, type FourShogiReplayEvent } from "../src/replay";
import singles from "../../../test-fixtures/matches/shogi-singles.json";
import doubles from "../../../test-fixtures/matches/shogi-doubles.json";
import singlesDraw from "../../../test-fixtures/matches/shogi-singles-draw.json";
import doublesDraw from "../../../test-fixtures/matches/shogi-doubles-draw.json";
import legacy from "../../../test-fixtures/matches/shogi-legacy.json";

type SavedState<State = FourShogiState> = State extends FourShogiState
  ? Omit<State, "repetitions" | "drawProposals"> & {
      drawProposals?: FourShogiState["drawProposals"];
    }
  : never;

for (const fixture of [singles, doubles, singlesDraw, doublesDraw, legacy])
  test(`${fixture.name}: 全イベント後の状態・最終結果が既存の再生と保存棋譜に一致する`, () => {
    const saved = fixture as unknown as {
      detail: {
        game: SavedState;
        replay: { initial: InitialStateOptions };
      };
      events: { event: FourShogiReplayEvent }[];
      checkpoints: {
        index: number;
        frame: { game: SavedState & { drawProposals: FourShogiState["drawProposals"] } };
      }[];
      frameCount: number;
    };
    const before = structuredClone(saved);
    const initial = saved.detail.replay.initial;
    const events = saved.events.map((entry) => entry.event);
    const frames = game.replay(initial, events);
    expect(frames.length + 1).toBe(saved.frameCount);
    let previous = createInitialState(initial);
    frames.forEach((state, index) => {
      const expected = applyReplayEvent(previous, events[index]);
      if (!expected.ok) throw new Error(`Invalid saved event ${index}: ${expected.reason}`);
      expect(state).toEqual(expected.state);
      expect(game.rules.getResult(state)).toEqual(expected.state.result);
      previous = expected.state;
    });
    for (const point of saved.checkpoints) {
      const state = point.index === 0 ? createInitialState(initial) : frames[point.index - 1];
      const { repetitions: _history, ...core } = state;
      expect(core).toEqual(point.frame.game);
    }
    const { repetitions: _history, ...final } = frames.at(-1)!;
    expect(final).toEqual({ drawProposals: [], ...saved.detail.game });
    expect(game.rules.getResult(frames.at(-1)!)).toEqual(saved.detail.game.result);
    expect(saved).toEqual(before);
  });

test("再生は不正な手・手番・重複脱落・終局後のイベントを拒否する", () => {
  const initial = game.catalog.defaultSettings;
  const state = createInitialState(initial);
  const action = getLegalActions(state)[0];
  const event: FourShogiReplayEvent = { type: "action", side: "south", action };
  expect(() => game.replay(initial, [{ ...event, side: "west" }])).toThrow();
  expect(() =>
    game.replay(initial, [{ ...event, action: { ...action, to: { x: -1, y: 0 } } }]),
  ).toThrow();
  const eliminate = { type: "eliminate", side: "west", reason: "left" } as const;
  expect(() => game.replay(initial, [eliminate, eliminate])).toThrow();
  expect(() => game.replay({ ...initial, mode: "doubles" }, [eliminate, event])).toThrow();
});
