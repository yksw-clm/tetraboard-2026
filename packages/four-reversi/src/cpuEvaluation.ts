import {
  colors,
  countStones,
  getActiveColors,
  type Color,
  type FourReversiState,
  type Team,
} from "./engine";
import { countLegalMoves, type SpendWork } from "./moves";

export type Features = {
  stones: number;
  mobility: number;
  corners: number;
  stableEdges: number;
  frontier: number;
  xSquares: number;
  cSquares: number;
};
export type EvaluationWeights = Record<keyof Features, readonly [number, number, number]>;
export const defaultEvaluationWeights: EvaluationWeights = {
  stones: [1, 1, 1],
  mobility: [3, 3, 3],
  corners: [25, 25, 25],
  stableEdges: [5, 5, 5],
  frontier: [0, 0, 0],
  xSquares: [-5, -5, -5],
  cSquares: [0, 0, 0],
};
export type PositionValues = Record<Color, number>;
export const teamForColor = (color: Color): Team =>
  color === "black" || color === "red" ? "black-red" : "white-blue";
const corners = [
  { x: 0, y: 0 },
  { x: 7, y: 0 },
  { x: 0, y: 7 },
  { x: 7, y: 7 },
];

export function resolveWeights(changes: Partial<EvaluationWeights> = {}): EvaluationWeights {
  for (const [name, value] of Object.entries(changes)) {
    if (
      !Object.hasOwn(defaultEvaluationWeights, name) ||
      !Array.isArray(value) ||
      value.length !== 3 ||
      value.some((n) => typeof n !== "number" || !Number.isFinite(n))
    )
      throw new TypeError("評価の係数は既知の特徴名と3個の有限数で指定してください");
  }
  return { ...defaultEvaluationWeights, ...changes };
}

export function positionFeatures(
  state: FourReversiState,
  spend?: SpendWork,
  includeMobility = true,
): { phase: 0 | 1 | 2; features: Record<Color, Features> } {
  const counts = countStones(state.board);
  const occupied = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const phase = occupied <= 24 ? 0 : occupied <= 48 ? 1 : 2;
  const features = Object.fromEntries(
    colors.map((color) => [
      color,
      {
        stones: counts[color],
        mobility: 0,
        corners: 0,
        stableEdges: 0,
        frontier: 0,
        xSquares: 0,
        cSquares: 0,
      },
    ]),
  ) as Record<Color, Features>;
  if (includeMobility) {
    const mobility = countLegalMoves(state.board, getActiveColors(state), spend);
    for (const color of colors) features[color].mobility = mobility[color];
  }
  const stable = new Set<number>();
  for (const { x, y } of corners) {
    const color = state.board[y][x];
    const dx = x === 0 ? 1 : -1;
    const dy = y === 0 ? 1 : -1;
    if (color !== null) {
      features[color].corners++;
      for (const [stepX, stepY] of [
        [dx, 0],
        [0, dy],
      ]) {
        for (let distance = 1; distance < 7; distance++) {
          const px = x + stepX * distance;
          const py = y + stepY * distance;
          if (state.board[py][px] !== color) break;
          stable.add(py * 8 + px);
        }
      }
    } else {
      const diagonal = state.board[y + dy][x + dx];
      if (diagonal !== null) features[diagonal].xSquares++;
      for (const adjacent of [state.board[y][x + dx], state.board[y + dy][x]])
        if (adjacent !== null) features[adjacent].cSquares++;
    }
  }
  for (const cell of stable) features[state.board[Math.floor(cell / 8)][cell % 8]!].stableEdges++;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const color = state.board[y][x];
      if (color === null) continue;
      let frontier = false;
      for (let dy = -1; dy <= 1 && !frontier; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (state.board[y + dy]?.[x + dx] === null) {
            frontier = true;
            break;
          }
        }
      if (frontier) features[color].frontier++;
    }
  return { phase, features };
}

export function evaluatePosition(
  state: FourReversiState,
  weights = defaultEvaluationWeights,
  spend?: SpendWork,
  includeMobility = true,
): PositionValues {
  const values: PositionValues = { black: 0, white: 0, red: 0, blue: 0 };
  if (state.status === "finished") {
    if (state.result.mode === "singles") {
      for (const standing of state.result.standings)
        values[standing.color] = (2 - standing.rank) * 1_000_000 + (standing.stoneCount ?? 0);
    } else {
      for (const color of colors) {
        const own = teamForColor(color);
        const other = own === "black-red" ? "white-blue" : "black-red";
        values[color] =
          (state.result.winner === null
            ? 0
            : state.result.winner === own
              ? 1_000_000
              : -1_000_000) +
          (state.result.teamTotals
            ? state.result.teamTotals[own] - state.result.teamTotals[other]
            : 0);
      }
    }
    return values;
  }
  const { features, phase } = positionFeatures(state, spend, includeMobility);
  const raw = Object.fromEntries(
    colors.map((color) => [
      color,
      Object.entries(features[color]).reduce(
        (sum, [name, value]) => sum + value * weights[name as keyof Features][phase],
        0,
      ),
    ]),
  ) as PositionValues;
  const active = getActiveColors(state);
  for (const color of colors) {
    const index = state.eliminatedColors.indexOf(color);
    if (index !== -1) {
      values[color] = (index - 2) * 1_000_000;
      continue;
    }
    const others = active.filter((other) => other !== color);
    const score =
      state.mode === "singles"
        ? raw[color] -
          (others.length ? others.reduce((sum, other) => sum + raw[other], 0) / others.length : 0)
        : (teamForColor(color) === "black-red" ? 1 : -1) *
          (raw.black + raw.red - raw.white - raw.blue);
    values[color] = Math.max(-99_999, Math.min(99_999, score));
  }
  return values;
}
