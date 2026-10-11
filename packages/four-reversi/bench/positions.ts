import {
  applyAction,
  getLegalMoves,
  countStones,
  createInitialState,
  type Cell,
  type FourReversiState,
  type GameMode,
} from "../src/index";
import { positionAt } from "./measurement";
import { solveEndgame } from "./oracle";

export function endgameCases(startSeed: number, count: number, maxEmpty = 4) {
  const positions: { id: string; seed: number; state: FourReversiState; labels: string[] }[] = [];
  const seen = new Set<string>();
  for (let seed = startSeed; positions.length < count && seed < startSeed + count * 30; seed++) {
    const mode: GameMode = seed % 2 ? "singles" : "doubles";
    const active = mode === "doubles" ? 4 : 2 + (seed % 3);
    const empties = 1 + (Math.floor(seed / 2) % maxEmpty);
    const state = positionAt(mode, seed, 56 - empties, active);
    if (state.status !== "playing") continue;
    const key = JSON.stringify([state.mode, state.board, state.turn, state.eliminatedColors]);
    if (seen.has(key)) continue;
    seen.add(key);
    const moves = getLegalMoves(state);
    const labels = [mode, `${active}-colors`, `${empties}-empties`];
    if (moves.some(({ x, y }) => (x === 0 || x === 7) && (y === 0 || y === 7)))
      labels.push("corner");
    if (moves.some(({ x, y }) => (x === 1 || x === 6) && (y === 1 || y === 6)))
      labels.push("x-square");
    if (
      moves.some(
        ({ x, y }) =>
          ((x === 0 || x === 7) && (y === 1 || y === 6)) ||
          ((y === 0 || y === 7) && (x === 1 || x === 6)),
      )
    )
      labels.push("c-square");
    if (
      moves.some((position) => {
        const result = applyAction(state, { type: "placeStone", position });
        return result.ok && result.passedColors.length > 0;
      })
    )
      labels.push("pass");
    if (moves.length === 1) labels.push("forced");
    positions.push({ id: `${mode}-${seed}-${active}-${empties}`, seed, state, labels });
  }
  if (positions.length !== count) throw new Error("終盤問題の必要件数を生成できません");
  return positions;
}

export function performancePositions() {
  const corpus: { id: string; state: FourReversiState }[] = [];
  for (const mode of ["singles", "doubles"] as const) {
    for (const plies of [0, 12, 24, 36, 48]) {
      for (const seed of plies === 0 ? [701] : [701, 702, 703, 704]) {
        const state = positionAt(mode, seed, plies);
        if (state.status === "playing") corpus.push({ id: `${mode}-${seed}-${plies}`, state });
      }
    }
  }
  for (const active of [2, 3]) {
    for (const seed of [705, 706]) {
      const state = positionAt("singles", seed, 36, active);
      if (state.status === "playing") corpus.push({ id: `singles-${seed}-36-${active}`, state });
    }
  }
  for (const entry of endgameCases(710, 8).filter((entry) => entry.labels.includes("pass")))
    corpus.push({ id: `performance-${entry.id}`, state: entry.state });
  return corpus;
}

export function tacticalCases(split: "training" | "validation") {
  const corpus = endgameCases(split === "training" ? 10000 : 50000, 200, 6);
  const board: Cell[][] = Array.from({ length: 8 }, () => Array<Cell>(8).fill("black"));
  board[0][1] = "red";
  board[0][2] = null;
  board[2][1] = "white";
  board[2][2] = null;
  board[3][1] = "white";
  board[4][1] = "blue";
  board[4][4] = "blue";
  board[5][split === "training" ? 5 : 6] = "white";
  board[6][6] = null;
  board[7][7] = null;
  corpus.push({
    id: `${split}-elimination-ban`,
    seed: 0,
    state: {
      ...createInitialState(split === "training" ? "singles" : "doubles"),
      board,
      moveNumber: 52,
    },
    labels: ["elimination-ban"],
  });
  const candidates = corpus
    .filter(({ state }) => getLegalMoves(state).length >= 2)
    .map((entry) => {
      const { state } = entry;
      if (state.status !== "playing") throw new Error("進行中の問題が必要です");
      const labels = [...entry.labels];
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          if (state.board[y][x] !== null) continue;
          const result = applyAction(state, { type: "placeStone", position: { x, y } });
          if (!result.ok && result.reason === "eliminates_player") labels.push("elimination-ban");
          if (
            result.ok &&
            result.state.status === "playing" &&
            result.state.turn !== state.turn &&
            getLegalMoves(result.state).some(
              (p) => (p.x === 0 || p.x === 7) && (p.y === 0 || p.y === 7),
            )
          )
            labels.push("corner-handover");
        }
      if (state.mode === "doubles") {
        const expected = solveEndgame(state);
        const gains = getLegalMoves(state).map((position) => {
          const result = applyAction(state, { type: "placeStone", position });
          if (!result.ok) throw new Error("不正な問題候補です");
          return { position, count: countStones(result.state.board)[state.turn!] };
        });
        const highest = Math.max(...gains.map((v) => v.count));
        if (
          gains.some(
            (v) =>
              v.count === highest &&
              !expected.moves.some((p) => p.x === v.position.x && p.y === v.position.y),
          )
        )
          labels.push("team-interest");
      }
      return { ...entry, labels: [...new Set(labels)], important: true };
    });
  const selected: typeof candidates = [];
  for (const label of [
    "corner-handover",
    "x-square",
    "c-square",
    "elimination-ban",
    "team-interest",
    "pass",
    "2-colors",
    "3-colors",
  ]) {
    const entry = candidates.find((v) => v.labels.includes(label));
    if (!entry) throw new Error(`戦術問題の分類が不足しています: ${label}`);
    if (!selected.includes(entry)) selected.push(entry);
  }
  for (const entry of candidates)
    if (selected.length < 25 && !selected.includes(entry)) selected.push(entry);
  if (selected.length !== 25) throw new Error("戦術問題25原局面が必要です");
  return selected;
}
