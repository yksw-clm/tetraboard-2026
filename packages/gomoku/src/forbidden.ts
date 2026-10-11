import { directions, inBounds, lineThrough, type Board, type Cell, type Position } from "./index";

export type ForbiddenReason = "double_three" | "double_four" | "overline";
type Four = { stones: Position[]; ends: Position[] };
const keyOf = (stones: Position[]) =>
  stones
    .map((p) => p.y * 15 + p.x)
    .sort((a, b) => a - b)
    .join(",");
const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

function fours(board: Board, origin: Position): Four[] {
  const found = new Map<string, Four>();
  for (const [dx, dy] of directions) {
    for (let offset = -4; offset <= 0; offset++) {
      const window = Array.from({ length: 5 }, (_, i) => ({
        x: origin.x + (offset + i) * dx,
        y: origin.y + (offset + i) * dy,
      }));
      if (window.some((p) => !inBounds(p) || board[p.y][p.x] === "white")) continue;
      const stones = window.filter((p) => board[p.y][p.x] === "black");
      const empty = window.filter((p) => board[p.y][p.x] === null);
      if (stones.length !== 4 || empty.length !== 1) continue;
      const end = empty[0];
      // 五連を越える完成点は四を構成しません。同じ四の両端は一つにまとめます。
      if (lineThrough(board, end, "black", dx, dy).length !== 5) continue;
      const key = keyOf(stones);
      const existing = found.get(key);
      if (existing) existing.ends.push(end);
      else found.set(key, { stones, ends: [end] });
    }
  }
  return [...found.values()];
}

function threes(board: Cell[][], origin: Position): Map<string, Position[]> {
  const found = new Map<string, Position[]>();
  for (const [dx, dy] of directions) {
    const nearby = [-3, -2, -1, 1, 2, 3].filter(
      (i) => board[origin.y + i * dy]?.[origin.x + i * dx] === "black",
    ).length;
    if (nearby < 2) continue;
    for (let offset = -3; offset <= 3; offset++) {
      if (offset === 0) continue;
      const next = { x: origin.x + offset * dx, y: origin.y + offset * dy };
      if (!inBounds(next) || board[next.y][next.x] !== null) continue;
      board[next.y][next.x] = "black";
      // 三の発展手は、その手で五連が成立する場合を含みません。
      if (!directions.some(([a, b]) => lineThrough(board, next, "black", a, b).length === 5)) {
        for (const four of fours(board, origin)) {
          if (four.ends.length !== 2 || !four.stones.some((p) => same(p, next))) continue;
          const key = keyOf(four.stones.filter((p) => !same(p, next)));
          const extensions = found.get(key) ?? [];
          if (!extensions.some((p) => same(p, next))) extensions.push(next);
          found.set(key, extensions);
        }
      }
      board[next.y][next.x] = null;
    }
  }
  return found;
}

function inspectPlaced(
  board: Cell[][],
  origin: Position,
  cache: Map<string, ForbiddenReason[]>,
): ForbiddenReason[] {
  const lengths = directions.map(([dx, dy]) => lineThrough(board, origin, "black", dx, dy).length);
  if (lengths.includes(5)) return [];
  const key =
    `${origin.x},${origin.y}:` +
    board
      .map((row) =>
        row.map((cell) => (cell === "black" ? "K" : cell === "white" ? "W" : ".")).join(""),
      )
      .join("");
  const cached = cache.get(key);
  if (cached) return cached;
  const reasons: ForbiddenReason[] = [];
  if (lengths.some((length) => length >= 6)) reasons.push("overline");
  if (fours(board, origin).length >= 2) reasons.push("double_four");
  const candidates = threes(board, origin);
  let realThrees = 0;
  if (candidates.size >= 2)
    for (const extensions of candidates.values()) {
      const legal = extensions.some((next) => {
        board[next.y][next.x] = "black";
        const result = inspectPlaced(board, next, cache);
        board[next.y][next.x] = null;
        return result.length === 0;
      });
      if (legal && ++realThrees === 2) {
        reasons.push("double_three");
        break;
      }
    }
  cache.set(key, reasons);
  return reasons;
}

/** 空点に黒を置く場合だけ呼び出します。再帰の各段で石が増えるため、判定は有限です。 */
export function forbiddenReasons(board: Board, position: Position): ForbiddenReason[] {
  if (!inBounds(position) || board[position.y][position.x] !== null) return [];
  const copy = board.map((row) => [...row]);
  copy[position.y][position.x] = "black";
  return inspectPlaced(copy, position, new Map());
}
