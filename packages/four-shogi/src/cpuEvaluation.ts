import { attacksSquare, getCheckState, inBounds, pieces } from "./board";
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

const pieceValues = { king: 0, rook: 800, gold: 500, silver: 400, pawn: 100 };
const victoryScore = 1_000_000;

function pieceValue(piece: Piece): number {
  if (!piece.promoted) return pieceValues[piece.kind];
  return piece.kind === "rook" ? 1_000 : piece.kind === "king" ? 0 : 500;
}

function rankScore(rank: number): number {
  return rank === 1 ? victoryScore : -(rank - 1) * victoryScore;
}

export function evaluatePosition(state: FourShogiState): Record<Side, number> {
  const scores: Record<Side, number> = { south: 0, west: 0, north: 0, east: 0 };
  if (state.status === "finished") {
    if (state.result.mode === "singles") {
      for (const standing of state.result.standings) {
        scores[standing.side] = rankScore(standing.rank);
      }
    } else {
      for (const side of sides) {
        scores[side] =
          state.result.winner === null
            ? 0
            : state.result.winner === teamForSide(side)
              ? victoryScore
              : -victoryScore;
      }
    }
    return scores;
  }

  const active = getActiveSides(state);
  const all = pieces(state.board);
  const checks = getCheckState(state);
  const assets: Record<Side, number> = { south: 0, west: 0, north: 0, east: 0 };
  const penalties: Record<Side, number> = { south: 0, west: 0, north: 0, east: 0 };
  for (const { piece } of all) {
    if (active.includes(piece.side)) assets[piece.side] += pieceValue(piece);
  }
  for (const side of active) {
    for (const kind of handPieceKinds) {
      assets[side] += state.hands[side][kind] * pieceValues[kind];
    }
    penalties[side] = checks[side] ? 200 : 0;
    const king = all.find(({ piece }) => piece.side === side && piece.kind === "king");
    if (!king) continue;
    const enemies = all.filter(
      ({ piece }) => active.includes(piece.side) && areEnemies(state.mode, side, piece.side),
    );
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const to = { x: king.position.x + dx, y: king.position.y + dy };
        if (
          inBounds(to) &&
          enemies.some(({ piece, position }) => attacksSquare(state.board, piece, position, to))
        ) {
          penalties[side] += 25;
        }
      }
    }
  }

  for (const side of sides) {
    if (state.mode === "doubles") {
      scores[side] = sides.reduce(
        (score, other) =>
          teamForSide(side) === teamForSide(other)
            ? score + assets[other] - penalties[other]
            : score - assets[other],
        0,
      );
    } else if (!active.includes(side)) {
      scores[side] = rankScore(state.eliminations.find((entry) => entry.side === side)!.rank!);
    } else {
      const enemies = active.filter((other) => other !== side);
      const averageEnemyAssets =
        enemies.length === 0
          ? 0
          : enemies.reduce((total, other) => total + assets[other], 0) / enemies.length;
      scores[side] =
        100_000 * (4 - active.length) + assets[side] - averageEnemyAssets - penalties[side];
    }
  }
  return scores;
}
