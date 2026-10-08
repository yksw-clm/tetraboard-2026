import { attackedPositions, inBounds, pieces } from "./board";
import {
  areEnemies,
  getActiveSides,
  handPieceKinds,
  sides,
  teamForSide,
  type FourShogiState,
  type Piece,
  type Side,
} from "./types";

export const defaultEvaluationWeights = /* @__PURE__ */ Object.freeze({
  undefended: 0.7,
  exchange: 0.45,
  kingRing: 35,
  check: 300,
  mobility: 3,
  advancement: 6,
  shelter: 12,
  survival: 5000,
});
export type EvaluationWeights = { readonly [Key in keyof typeof defaultEvaluationWeights]: number };
const pieceValues = { king: 0, rook: 800, gold: 500, silver: 400, pawn: 100 };
const victoryScore = 1_000_000;

export function pieceValue(piece: Piece): number {
  return !piece.promoted
    ? pieceValues[piece.kind]
    : piece.kind === "rook"
      ? 1000
      : piece.kind === "king"
        ? 0
        : 500;
}
function rankScore(rank: number): number {
  return rank === 1 ? victoryScore : -(rank - 1) * victoryScore;
}

export function evaluatePosition(
  state: FourShogiState,
  weights: EvaluationWeights = defaultEvaluationWeights,
): Record<Side, number> {
  const scores: Record<Side, number> = { south: 0, west: 0, north: 0, east: 0 };
  if (state.status === "finished") {
    for (const side of sides)
      scores[side] =
        state.result.mode === "singles"
          ? rankScore(state.result.standings.find((entry) => entry.side === side)!.rank)
          : state.result.winner === null
            ? 0
            : state.result.winner === teamForSide(side)
              ? victoryScore
              : -victoryScore;
    return scores;
  }
  const active = getActiveSides(state);
  const all = pieces(state.board).filter(({ piece }) => active.includes(piece.side));
  const attacks = Object.fromEntries(sides.map((side) => [side, new Uint8Array(81)])) as Record<
    Side,
    Uint8Array
  >;
  const cheapest = Object.fromEntries(
    sides.map((side) => [side, new Float64Array(81).fill(Infinity)]),
  ) as Record<Side, Float64Array>;
  const assets: Record<Side, number> = { south: 0, west: 0, north: 0, east: 0 };
  // 同じ節点の利きを共有し、駒の危険・可動性・玉周辺を一度の集計で評価します。
  for (const { piece, position } of all) {
    const value = pieceValue(piece);
    assets[piece.side] += value;
    const destinations = attackedPositions(state.board, piece, position);
    for (const to of destinations) {
      const square = to.y * 9 + to.x;
      attacks[piece.side][square]++;
      cheapest[piece.side][square] = Math.min(
        cheapest[piece.side][square],
        piece.kind === "king" ? 2000 : value,
      );
    }
    if (piece.kind !== "king") {
      const mobility = destinations.filter(
        (to) => state.board[to.y][to.x]?.side !== piece.side,
      ).length;
      assets[piece.side] += mobility * weights.mobility;
      if (piece.kind === "pawn" && !piece.promoted) {
        const advance =
          piece.side === "south"
            ? 8 - position.y
            : piece.side === "north"
              ? position.y
              : piece.side === "west"
                ? position.x
                : 8 - position.x;
        assets[piece.side] += advance * weights.advancement;
      }
    }
  }
  for (const side of active) {
    const enemies = active.filter((enemy) => areEnemies(state.mode, side, enemy));
    const own = all.filter(({ piece }) => piece.side === side);
    for (const kind of handPieceKinds) assets[side] += state.hands[side][kind] * pieceValues[kind];
    for (const { piece, position } of own) {
      const square = position.y * 9 + position.x;
      const enemyCost = Math.min(...enemies.map((enemy) => cheapest[enemy][square]));
      if (piece.kind !== "king" && Number.isFinite(enemyCost)) {
        const guarded = attacks[side][square] > 0;
        const risk = guarded
          ? Math.max(0, pieceValue(piece) - enemyCost) * weights.exchange
          : pieceValue(piece) * weights.undefended;
        const urgency =
          state.turn === side
            ? 0.4
            : enemies.some((enemy) => state.turn === enemy && attacks[enemy][square])
              ? 1
              : 0.75;
        assets[side] -= risk * urgency;
      }
      if (piece.kind !== "king") continue;
      const threatened = (x: number, y: number) =>
        enemies.some((enemy) => attacks[enemy][y * 9 + x] > 0);
      if (threatened(position.x, position.y)) assets[side] -= weights.check;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const to = { x: position.x + dx, y: position.y + dy };
          if (!inBounds(to)) continue;
          if (threatened(to.x, to.y)) assets[side] -= weights.kingRing;
          else if (attacks[side][to.y * 9 + to.x] > 1) assets[side] += weights.shelter;
        }
    }
  }
  for (const side of sides) {
    if (state.mode === "doubles") {
      scores[side] = sides.reduce(
        (sum, other) =>
          sum + (teamForSide(side) === teamForSide(other) ? assets[other] : -assets[other]),
        0,
      );
    } else if (!active.includes(side)) {
      scores[side] = rankScore(state.eliminations.find((entry) => entry.side === side)!.rank!);
    } else {
      const opponents = active.filter((other) => other !== side).map((other) => assets[other]);
      const average =
        opponents.reduce((sum, value) => sum + value, 0) / Math.max(1, opponents.length);
      const strongest = opponents.length > 0 ? Math.max(...opponents) : 0;
      scores[side] =
        weights.survival * (4 - active.length) + assets[side] - 0.6 * average - 0.4 * strongest;
    }
  }
  return scores;
}
