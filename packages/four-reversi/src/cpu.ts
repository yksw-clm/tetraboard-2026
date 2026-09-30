import {
  applyAction,
  colors,
  countStones,
  getLegalMoves,
  getLegalMovesForColor,
  type Color,
  type FourReversiState,
  type Position,
} from "./index";

export type CpuLevel = 1 | 2;

function evaluate(state: FourReversiState): Record<Color, number> {
  const scores: Record<Color, number> = { black: 0, white: 0, red: 0, blue: 0 };
  const counts = countStones(state.board);
  if (state.status === "finished") {
    if (state.result.mode === "singles") {
      for (const standing of state.result.standings) {
        scores[standing.color] = 10_000 * (5 - standing.rank) + (standing.stoneCount ?? 0);
      }
    } else {
      for (const color of colors) {
        const team = color === "black" || color === "red" ? "black-red" : "white-blue";
        scores[color] =
          (state.result.winner === null ? 20_000 : state.result.winner === team ? 40_000 : 0) +
          counts[color];
      }
    }
    return scores;
  }

  for (const color of colors) {
    if (state.eliminatedColors.includes(color)) {
      scores[color] = -10_000;
      continue;
    }
    let corners = 0;
    let edges = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (state.board[y][x] !== color) continue;
        if ((x === 0 || x === 7) && (y === 0 || y === 7)) corners++;
        else if (x === 0 || x === 7 || y === 0 || y === 7) edges++;
      }
    }
    scores[color] =
      counts[color] + 25 * corners + 5 * edges + 3 * getLegalMovesForColor(state, color).length;
  }
  return scores;
}

export function chooseCpuMove(
  state: FourReversiState,
  level: CpuLevel,
  random: () => number = Math.random,
): Position | null {
  if (state.status === "finished") return null;
  const moves = getLegalMoves(state);
  if (moves.length === 0) return null;
  if (level === 1) {
    return moves[Math.min(moves.length - 1, Math.max(0, Math.floor(random() * moves.length)))];
  }

  const color = state.turn;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    const first = applyAction(state, { type: "placeStone", position: move });
    if (!first.ok) continue;
    let score = evaluate(first.state)[color];
    if (first.state.status === "playing") {
      const opponent = first.state.turn;
      let replyScore = -Infinity;
      for (const reply of getLegalMoves(first.state)) {
        const second = applyAction(first.state, { type: "placeStone", position: reply });
        if (!second.ok) continue;
        const values = evaluate(second.state);
        if (values[opponent] > replyScore) {
          replyScore = values[opponent];
          score = values[color];
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}
