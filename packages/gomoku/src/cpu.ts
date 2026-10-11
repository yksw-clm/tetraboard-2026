import {
  applyAction,
  boardSize,
  directions,
  getLegalMoves,
  getLegalMovesForColor,
  inBounds,
  winningLines,
  type Board,
  type Color,
  type GomokuState,
  type Position,
} from "./index";

export type CpuLevel = 1 | 2;
export const cpuSearchLimits = { radius: 2, width: 12, depth: 2, nodes: 156 } as const;
const weights = [0, 1, 10, 200, 10_000, 1_000_000];
const other = (color: Color): Color => (color === "black" ? "white" : "black");
const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

function nearby(board: Board, moves: Position[]): Position[] {
  const selected = moves.filter(({ x, y }) => {
    for (let dy = -cpuSearchLimits.radius; dy <= cpuSearchLimits.radius; dy++)
      for (let dx = -cpuSearchLimits.radius; dx <= cpuSearchLimits.radius; dx++)
        if (board[y + dy]?.[x + dx] != null) return true;
    return false;
  });
  if (selected.length) return selected;
  if (board.every((row) => row.every((cell) => cell === null)))
    return moves.filter((p) => same(p, { x: 7, y: 7 }));
  return moves;
}

function evaluate(board: Board, color: Color): number {
  let score = 0;
  for (const [dx, dy] of directions)
    for (let y = 0; y < boardSize; y++)
      for (let x = 0; x < boardSize; x++) {
        if (!inBounds({ x: x + 4 * dx, y: y + 4 * dy })) continue;
        let own = 0,
          enemy = 0;
        for (let i = 0; i < 5; i++) {
          const cell = board[y + i * dy][x + i * dx];
          if (cell === color) own++;
          else if (cell !== null) enemy++;
        }
        if (!enemy) score += weights[own];
        if (!own) score -= weights[enemy];
      }
  return score;
}

function ordered(state: GomokuState, moves: Position[], color: Color): Position[] {
  const board = state.board.map((row) => [...row]);
  return moves
    .map((move) => {
      board[move.y][move.x] = color;
      const score = evaluate(board, color);
      board[move.y][move.x] = null;
      return { move, score };
    })
    .sort((a, b) => b.score - a.score || a.move.y - b.move.y || a.move.x - b.move.x)
    .map((entry) => entry.move);
}

function immediateWins(state: GomokuState, moves: Position[], color: Color): Position[] {
  return moves.filter((p) => winningLines(state.board, p, color, state.forbiddenRules).length > 0);
}

export function analyzeCpuMove(
  state: GomokuState,
  level: CpuLevel,
  random: () => number = Math.random,
): { move: Position | null; nodes: number } {
  if (state.status === "finished") return { move: null, nodes: 0 };
  const legal = getLegalMoves(state);
  if (!legal.length) return { move: null, nodes: 0 };
  const nearbyMoves = nearby(state.board, legal);
  if (level === 1)
    return {
      move: nearbyMoves[
        Math.min(nearbyMoves.length - 1, Math.max(0, Math.floor(random() * nearbyMoves.length)))
      ],
      nodes: 0,
    };
  const color = state.turn;
  // 即勝ち・防御は近傍や探索幅による絞り込みの前に全合法点で確認します。
  const wins = immediateWins(state, legal, color);
  if (wins.length) return { move: wins[0], nodes: 0 };
  const threats = immediateWins(state, getLegalMovesForColor(state, other(color)), other(color));
  const blocks = legal.filter((move) => threats.some((threat) => same(move, threat)));
  const candidates = ordered(state, blocks.length ? blocks : nearbyMoves, color).slice(
    0,
    cpuSearchLimits.width,
  );
  let best = candidates[0],
    bestScore = -Infinity,
    nodes = 0;
  for (const move of candidates) {
    const first = applyAction(state, { type: "placeStone", position: move });
    nodes++;
    if (!first.ok) throw new Error("CPU selected an illegal move");
    let score = first.state.result
      ? first.state.result.winner === color
        ? 10_000_000
        : first.state.result.winner === null
          ? 0
          : -10_000_000
      : evaluate(first.state.board, color);
    if (first.state.status === "playing") {
      const replies = getLegalMoves(first.state);
      if (immediateWins(first.state, replies, other(color)).length) score = -10_000_000;
      else
        for (const reply of ordered(
          first.state,
          nearby(first.state.board, replies),
          other(color),
        ).slice(0, cpuSearchLimits.width)) {
          const second = applyAction(first.state, { type: "placeStone", position: reply });
          nodes++;
          if (!second.ok) throw new Error("CPU selected an illegal reply");
          const value = second.state.result
            ? second.state.result.winner === color
              ? 10_000_000
              : second.state.result.winner === null
                ? 0
                : -10_000_000
            : evaluate(second.state.board, color);
          score = Math.min(score, value);
        }
    }
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return { move: best, nodes };
}

export function chooseCpuMove(
  state: GomokuState,
  level: CpuLevel,
  random: () => number = Math.random,
): Position | null {
  return analyzeCpuMove(state, level, random).move;
}
