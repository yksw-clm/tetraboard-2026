import { applyAction, getLegalMoves, type FourReversiState, type GameMode } from "../src/index";
import { positionAt } from "./measurement";

export function endgameCases(startSeed: number, count: number) {
  const positions: { id: string; seed: number; state: FourReversiState; labels: string[] }[] = [];
  const seen = new Set<string>();
  for (let seed = startSeed; positions.length < count && seed < startSeed + count * 30; seed++) {
    const mode: GameMode = seed % 2 ? "singles" : "doubles";
    const active = mode === "doubles" ? 4 : 2 + (seed % 3);
    const empties = 1 + (Math.floor(seed / 2) % 4);
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
