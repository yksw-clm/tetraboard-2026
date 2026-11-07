import { expect, test } from "bun:test";
import {
  applyAction,
  countStones,
  createInitialState,
  getLegalMoves,
  type Cell,
  type Color,
  type FourReversiState,
  type Position,
} from "../../four-reversi/src/engine";
import fixtures from "../fixtures/four-reversi-v1.json";

const symbols: Record<Color, string> = { black: "K", white: "W", red: "R", blue: "B" };
const cells: Record<string, Cell> = { ".": null, K: "black", W: "white", R: "red", B: "blue" };
function snapshot(state: FourReversiState) {
  if (state.result?.mode === "doubles") throw new Error("ダブルスは今回の対象外です");
  return {
    board: state.board.map((row) =>
      row.map((cell) => (cell === null ? "." : symbols[cell])).join(""),
    ),
    turn: state.turn,
    moveNumber: state.moveNumber,
    lastMove: state.lastMove,
    consecutivePasses: state.consecutivePasses,
    result: state.result
      ? { reason: state.result.reason, standings: state.result.standings }
      : null,
  };
}

test("初期局面は固定fixtureと一致する", () => {
  expect(fixtures.formatVersion).toBe(1);
  expect<unknown>(snapshot(createInitialState("singles"))).toEqual({
    ...fixtures.cases[0].input,
    result: null,
  });
});

for (const fixture of fixtures.cases) {
  test(`TypeScriptルールと共通fixture: ${fixture.name}`, () => {
    let state: FourReversiState = {
      ...createInitialState("singles"),
      ...fixture.input,
      turn: fixture.input.turn as Color,
      consecutivePasses: fixture.input.consecutivePasses as Color[],
      board: fixture.input.board.map((row) => [...row].map((symbol) => cells[symbol])),
      status: "playing",
      result: null,
    };
    for (const step of fixture.steps) {
      const original = structuredClone(state);
      expect(getLegalMoves(state)).toEqual(step.legalMoves);
      const result = applyAction(state, { type: "placeStone", position: step.position });
      expect(state).toEqual(original);
      if (result.ok) {
        expect<unknown>({
          ok: true,
          state: snapshot(result.state),
          flipped: result.flipped,
          passedColors: result.passedColors,
        }).toEqual(step.expected);
        state = result.state;
      } else {
        expect<unknown>(result).toEqual(step.expected);
      }
    }
  });
}

type LoggedState = {
  board: Cell[][];
  turn: Color | null;
  moveNumber: number;
  lastMove: Position | null;
  consecutivePasses: Color[];
  result: {
    reason: "board_full" | "all_passed";
    standings: { color: Color; rank: number; stoneCount: number }[];
  } | null;
};
type GameLog = {
  format_version: number;
  game_index: number;
  game_seed: number;
  initial_state: LoggedState;
  moves: {
    color: Color;
    legal_moves: Position[];
    position: Position;
    flipped: Position[];
    passed_colors: Color[];
    move_number: number;
    search_nodes: number;
    trials: number;
  }[];
  final_state: LoggedState;
  outcomes: { color: Color; score: number; rank: number; won: boolean; shared_first: boolean }[];
};

function loggedSnapshot(state: LoggedState) {
  return {
    ...state,
    board: state.board.map((row) =>
      row.map((cell) => (cell === null ? "." : symbols[cell])).join(""),
    ),
  };
}

test("Rust CLIの100局をTypeScriptで全着手・パス・終局結果まで再検証する", () => {
  const result = Bun.spawnSync(
    [
      "cargo",
      "run",
      "--quiet",
      "--locked",
      "-p",
      "tetraboard-ai-benchmark",
      "--",
      "--games",
      "100",
      "--seed",
      "0",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const logs = result.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as GameLog);
  expect(logs).toHaveLength(100);
  for (const [index, log] of logs.entries()) {
    expect(log.format_version).toBe(1);
    expect(log.game_index).toBe(index);
    expect(log.game_seed).toBe(index);
    let state = createInitialState("singles");
    expect(snapshot(state)).toEqual(loggedSnapshot(log.initial_state));
    for (const entry of log.moves) {
      expect(state.turn).toBe(entry.color);
      expect(getLegalMoves(state)).toEqual(entry.legal_moves);
      expect(entry.search_nodes).toBe(0);
      expect(entry.trials).toBe(0);
      const result = applyAction(state, { type: "placeStone", position: entry.position });
      if (!result.ok) throw new Error(`Rustの着手を拒否しました: ${result.reason}`);
      expect(result.flipped).toEqual(entry.flipped);
      expect(result.passedColors).toEqual(entry.passed_colors);
      expect(result.state.moveNumber).toBe(entry.move_number);
      state = result.state;
    }
    expect(state.status).toBe("finished");
    expect(snapshot(state)).toEqual(loggedSnapshot(log.final_state));
    if (state.result?.mode !== "singles") throw new Error("シングルスの結果がありません");
    const counts = countStones(state.board);
    const winners = state.result.standings.filter((standing) => standing.rank === 1).length;
    expect(log.outcomes).toEqual(
      state.result.standings.map((standing) => ({
        color: standing.color,
        score: counts[standing.color],
        rank: standing.rank,
        won: standing.rank === 1,
        shared_first: standing.rank === 1 && winners > 1,
      })),
    );
  }
}, 15000);
