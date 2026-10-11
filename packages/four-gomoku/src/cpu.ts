import {
  applyAction,
  boardSize,
  colors,
  directions,
  getActiveColors,
  getLegalMoves,
  inBounds,
  isAlly,
  winningLines,
  type Board,
  type Color,
  type FourGomokuState,
  type GameMode,
  type Position,
} from "./index";
export type CpuLevel = 1 | 2;
export const cpuSearchLimits = { radius: 2, width: 12, depth: 2, nodes: 156 } as const;
const weights = [0, 1, 10, 200, 10_000, 1_000_000];
function nearby(board: Board, moves: Position[]): Position[] {
  const selected = moves.filter(({ x, y }) => {
    for (let dy = -cpuSearchLimits.radius; dy <= cpuSearchLimits.radius; dy++)
      for (let dx = -cpuSearchLimits.radius; dx <= cpuSearchLimits.radius; dx++)
        if (board[y + dy]?.[x + dx] != null) return true;
    return false;
  });
  return selected.length ? selected : moves;
}
function evaluate(board: Board, color: Color, mode: GameMode): number {
  let score = 0;
  for (const [dx, dy] of directions)
    for (let y = 0; y < boardSize; y++)
      for (let x = 0; x < boardSize; x++) {
        if (!inBounds({ x: x + 4 * dx, y: y + 4 * dy })) continue;
        let own = 0,
          blocked = false;
        for (let i = 0; i < 5; i++) {
          const c = board[y + i * dy][x + i * dx];
          if (c !== null) {
            if (isAlly(mode, color, c)) own++;
            else blocked = true;
          }
        }
        if (!blocked) score += weights[own];
      }
  return score;
}
function ordered(state: FourGomokuState, moves: Position[], color: Color): Position[] {
  const board = state.board.map((row) => [...row]);
  return moves
    .map((move) => {
      board[move.y][move.x] = color;
      const score = evaluate(board, color, state.mode);
      board[move.y][move.x] = null;
      return { move, score };
    })
    .sort((a, b) => b.score - a.score || a.move.y - b.move.y || a.move.x - b.move.x)
    .map((item) => item.move);
}
const wins = (state: FourGomokuState, moves: Position[], color: Color) =>
  moves.filter((p) => winningLines(state.board, p, color, state.mode).length > 0);
function value(state: FourGomokuState, color: Color): number {
  const active = getActiveColors(state);
  return (
    evaluate(state.board, color, state.mode) -
    Math.max(
      0,
      ...active
        .filter((c) => !isAlly(state.mode, c, color))
        .map((c) => evaluate(state.board, c, state.mode)),
    )
  );
}
export function analyzeCpuMove(
  state: FourGomokuState,
  level: CpuLevel,
  random: () => number = Math.random,
): { move: Position | null; nodes: number } {
  if (state.status === "finished") return { move: null, nodes: 0 };
  const legal = getLegalMoves(state);
  if (!legal.length) return { move: null, nodes: 0 };
  const near = nearby(state.board, legal);
  if (level === 1)
    return {
      move: near[Math.min(near.length - 1, Math.max(0, Math.floor(random() * near.length)))],
      nodes: 0,
    };
  const color = state.turn;
  const immediate = wins(state, legal, color);
  if (immediate.length) return { move: immediate[0], nodes: 0 };
  // 勝ち抜け・脱落者を除き、次に回る敵から全空点の脅威を確認します。
  const enemies = Array.from(
    { length: 3 },
    (_, i) => colors[(colors.indexOf(color) + i + 1) % 4],
  ).filter((c) => getActiveColors(state).includes(c) && !isAlly(state.mode, c, color));
  const threats = enemies.map((c) => wins(state, legal, c));
  const blocks = threats.find((list) => list.length) ?? [];
  const candidates = ordered(state, blocks.length ? blocks : near, color).slice(
    0,
    cpuSearchLimits.width,
  );
  let best = candidates[0],
    bestScore = -Infinity,
    nodes = 0;
  for (const move of candidates) {
    const first = applyAction(state, { type: "placeStone", position: move });
    nodes++;
    if (!first.ok) throw new Error("Illegal CPU move");
    let score = value(first.state, color);
    if (first.state.status === "playing") {
      const nextColor = first.state.turn;
      const allied = isAlly(state.mode, color, nextColor);
      const replies = getLegalMoves(first.state);
      const immediateReplies = wins(first.state, replies, nextColor);
      if (immediateReplies.length) score = allied ? 10_000_000 : -10_000_000;
      else {
        let responseScore = allied ? -Infinity : Infinity;
        for (const reply of ordered(
          first.state,
          nearby(first.state.board, replies),
          nextColor,
        ).slice(0, cpuSearchLimits.width)) {
          const second = applyAction(first.state, { type: "placeStone", position: reply });
          nodes++;
          if (!second.ok) throw new Error("Illegal CPU reply");
          const v = value(second.state, color);
          responseScore = allied ? Math.max(responseScore, v) : Math.min(responseScore, v);
        }
        if (Number.isFinite(responseScore)) score = responseScore;
      }
    }
    if (
      score > bestScore ||
      (score === bestScore && (move.y < best.y || (move.y === best.y && move.x < best.x)))
    ) {
      bestScore = score;
      best = move;
    }
  }
  return { move: best, nodes };
}
export function chooseCpuMove(
  state: FourGomokuState,
  level: CpuLevel,
  random: () => number = Math.random,
): Position | null {
  return analyzeCpuMove(state, level, random).move;
}
