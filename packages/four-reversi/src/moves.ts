import type { Cell, Color, FourReversiState, MoveError, Position } from "./engine";

export type SpendWork = (cost?: number) => void;
export type LegalPlacement = {
  sourceBoard: FourReversiState["board"];
  activeKey: string;
  color: Color;
  position: Position;
  board: Cell[][];
  flipped: Position[];
};
const directions = [-1, 0, 1].flatMap((dy) =>
  [-1, 0, 1].filter((dx) => dx !== 0 || dy !== 0).map((dx) => ({ dx, dy })),
);

export function countStones(board: FourReversiState["board"]): Record<Color, number> {
  const counts: Record<Color, number> = { black: 0, white: 0, red: 0, blue: 0 };
  for (const row of board) for (const cell of row) if (cell !== null) counts[cell]++;
  return counts;
}

function captures(
  board: FourReversiState["board"],
  color: Color,
  { x: fromX, y: fromY }: Position,
) {
  const flipped: Position[] = [];
  for (const { dx, dy } of directions) {
    const start = flipped.length;
    let x = fromX + dx;
    let y = fromY + dy;
    let closed = false;
    while (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const cell = board[y][x];
      if (cell === null) break;
      if (cell === color) {
        closed = true;
        break;
      }
      flipped.push({ x, y });
      x += dx;
      y += dy;
    }
    if (!closed) flipped.length = start;
  }
  return flipped;
}

function checkPlacement(
  board: FourReversiState["board"],
  color: Color,
  active: readonly Color[],
  position: Position,
  counts = countStones(board),
): { ok: true; flipped: Position[] } | { ok: false; reason: Exclude<MoveError, "game_finished"> } {
  const { x, y } = position;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= 8 || y < 0 || y >= 8)
    return { ok: false, reason: "out_of_bounds" };
  if (board[y][x] !== null) return { ok: false, reason: "occupied" };
  const flipped = captures(board, color, position);
  if (!flipped.length) return { ok: false, reason: "no_capture" };
  const remaining = { ...counts };
  for (const p of flipped) remaining[board[p.y][p.x]!]--;
  if (active.some((other) => other !== color && remaining[other] === 0))
    return { ok: false, reason: "eliminates_player" };
  return { ok: true, flipped };
}

export function createPlacement(
  board: FourReversiState["board"],
  color: Color,
  active: readonly Color[],
  position: Position,
  counts = countStones(board),
): { ok: true; move: LegalPlacement } | { ok: false; reason: Exclude<MoveError, "game_finished"> } {
  const checked = checkPlacement(board, color, active, position, counts);
  if (!checked.ok) return checked;
  const { x, y } = position;
  const { flipped } = checked;
  const next = board.map((row) => [...row]);
  next[y][x] = color;
  for (const p of flipped) next[p.y][p.x] = color;
  return {
    ok: true,
    move: {
      sourceBoard: board,
      activeKey: active.join(","),
      color,
      position: { ...position },
      board: next,
      flipped,
    },
  };
}

export function countLegalMoves(
  board: FourReversiState["board"],
  active: readonly Color[],
  spend?: SpendWork,
): Record<Color, number> {
  // 全色の可動性を1回の空点走査で数え、評価に不要な着手後盤面を生成しません。
  spend?.();
  const counts = countStones(board);
  const result: Record<Color, number> = { black: 0, white: 0, red: 0, blue: 0 };
  let scanned = 0;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      if (board[y][x] !== null) continue;
      if (scanned++ % 8 === 0) spend?.();
      for (const color of active)
        if (checkPlacement(board, color, active, { x, y }, counts).ok) result[color]++;
    }
  return result;
}

export function generatePlacements(
  board: FourReversiState["board"],
  color: Color,
  active: readonly Color[],
  firstOnly = false,
  spend?: SpendWork,
): LegalPlacement[] {
  spend?.();
  const counts = countStones(board);
  const moves: LegalPlacement[] = [];
  let scanned = 0;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      if (board[y][x] !== null) continue;
      if (scanned++ % 8 === 0) spend?.();
      const result = createPlacement(board, color, active, { x, y }, counts);
      if (!result.ok) continue;
      moves.push(result.move);
      if (firstOnly) return moves;
    }
  return moves;
}
