import { expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  getLegalMoves,
  type Cell,
  type Color,
  type FourReversiState,
} from "../../four-reversi/src/engine";
import fixture from "../fixtures/elimination-v1.json";
const cells: Record<string, Cell> = { ".": null, K: "black", W: "white", R: "red", B: "blue" };
const symbols: Record<Color, string> = { black: "K", white: "W", red: "R", blue: "B" };
for (const entry of fixture.cases)
  test(`脱落の固定fixture: ${entry.name}`, () => {
    let state = {
      ...createInitialState("singles"),
      ...entry.input,
      board: entry.input.board.map((row) => [...row].map((c) => cells[c])),
    } as FourReversiState;
    for (const step of entry.steps) {
      expect(getLegalMoves(state)).toEqual(step.legalMoves);
      const before = structuredClone(state);
      const event = step.event;
      const result =
        event.type === "eliminate"
          ? eliminateColor(state, event.color as Color)
          : applyAction(state, { type: "placeStone", position: event.position! });
      expect(state).toEqual(before);
      if (!result.ok) {
        expect<unknown>(result).toEqual(step.expected);
        continue;
      }
      state = result.state;
      expect(state.result?.mode).not.toBe("doubles");
      expect<unknown>({
        ok: true,
        state: {
          board: state.board.map((row) => row.map((c) => (c ? symbols[c] : ".")).join("")),
          turn: state.turn,
          moveNumber: state.moveNumber,
          lastMove: state.lastMove,
          consecutivePasses: state.consecutivePasses,
          ...(state.eliminatedColors.length ? { eliminatedColors: state.eliminatedColors } : {}),
          result:
            state.result?.mode === "singles"
              ? { reason: state.result.reason, standings: state.result.standings }
              : null,
        },
        passedColors: result.passedColors,
        ...("flipped" in result ? { flipped: result.flipped } : {}),
      }).toEqual(step.expected);
    }
  });
