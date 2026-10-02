import { attacksSquare, isInCheck, pieces } from "./board";
import { hasOrdinaryMove, type OrdinaryMove } from "./moves";
import {
  sides,
  usesAttackRestriction,
  type AttackReason,
  type AttackRelation,
  type Board,
  type FourShogiState,
  type Piece,
  type Position,
  type Side,
  type StateBase,
} from "./types";

type LocatedPiece = { piece: Piece; position: Position };

function samePosition(left: Position, right: Position): boolean {
  return left.x === right.x && left.y === right.y;
}

function emptyRecaptureSquares(): StateBase["recaptureSquares"] {
  return { south: [], west: [], north: [], east: [] };
}

function threatensTarget(
  board: Board,
  attacker: LocatedPiece,
  target: LocatedPiece,
  king: LocatedPiece,
  defenders: readonly LocatedPiece[],
): boolean {
  if (attacker.piece.kind === "king" || target.piece.kind === "king") return false;
  if (!attacksSquare(board, attacker.piece, attacker.position, target.position)) return false;
  if (target.piece.kind === "rook") return true;
  const defended = defenders.some(
    (defender) =>
      defender.piece.id !== target.piece.id &&
      attacksSquare(board, defender.piece, defender.position, target.position),
  );
  if (target.piece.kind === "pawn") {
    const distance = Math.max(
      Math.abs(target.position.x - king.position.x),
      Math.abs(target.position.y - king.position.y),
    );
    return distance <= 2 && (attacker.piece.kind === "pawn" || !defended);
  }
  return attacker.piece.kind !== "rook" || !defended;
}

function coversKingNeighbor(board: Board, attacker: LocatedPiece, king: LocatedPiece): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const position = { x: king.position.x + dx, y: king.position.y + dy };
      if (position.x < 0 || position.x >= 9 || position.y < 0 || position.y >= 9) continue;
      if (board[position.y]?.[position.x]?.side === king.piece.side) continue;
      if (attacksSquare(board, attacker.piece, attacker.position, position)) return true;
    }
  }
  return false;
}

export function classifyAttacks(
  before: FourShogiState,
  side: Side,
  move: OrdinaryMove,
): AttackRelation[] {
  if (!usesAttackRestriction(before) || isInCheck(before, side)) return [];
  if (
    move.captured &&
    before.recaptureSquares[side].some((position) => samePosition(position, move.action.to))
  ) {
    return [];
  }

  const beforePieces = pieces(before.board);
  const afterPieces = pieces(move.state.board);
  const beforeById = new Map(beforePieces.map((entry) => [entry.piece.id, entry]));
  const ownPieces = afterPieces.filter((entry) => entry.piece.side === side);
  const relations: AttackRelation[] = [];

  for (const targetSide of sides) {
    if (targetSide === side) continue;
    const targets = afterPieces.filter((entry) => entry.piece.side === targetSide);
    const king = targets.find((entry) => entry.piece.kind === "king");
    if (!king) continue;
    const beforeKing = beforeById.get(king.piece.id);
    const reasons: AttackReason[] = [];
    const targetPieceIds: number[] = [];

    if (!isInCheck(before, targetSide) && isInCheck(move.state, targetSide)) {
      reasons.push("check");
    }
    if (
      move.piece.kind !== "king" &&
      move.captured?.side === targetSide &&
      move.captured.kind !== "pawn" &&
      move.captured.kind !== "king"
    ) {
      reasons.push("capture");
    }

    for (const target of targets) {
      if (target.piece.kind === "king") continue;
      // 同じ標的駒への追加の利きは、着手前に続いている攻撃関係で免除します。
      if (
        before.attackRelations.some(
          (relation) =>
            relation.target === targetSide &&
            relation.reasons.includes("threat") &&
            relation.targetPieceIds.includes(target.piece.id),
        )
      ) {
        continue;
      }
      if (
        ownPieces.some((attacker) => {
          if (!threatensTarget(move.state.board, attacker, target, king, targets)) return false;
          const oldAttacker = beforeById.get(attacker.piece.id);
          const oldTarget = beforeById.get(target.piece.id);
          return (
            !oldAttacker ||
            !oldTarget ||
            !attacksSquare(
              before.board,
              oldAttacker.piece,
              oldAttacker.position,
              oldTarget.position,
            )
          );
        })
      ) {
        targetPieceIds.push(target.piece.id);
      }
    }
    if (targetPieceIds.length > 0) reasons.push("threat");

    if (
      afterPieces.some((attacker) => {
        if (attacker.piece.side === targetSide || attacker.piece.kind === "king") return false;
        if (!coversKingNeighbor(move.state.board, attacker, king)) return false;
        const oldAttacker = beforeById.get(attacker.piece.id);
        // マスが入れ替わっても、同じ駒が周囲のどこかを塞ぎ続けていれば維持です。
        return (
          !oldAttacker || !beforeKing || !coversKingNeighbor(before.board, oldAttacker, beforeKing)
        );
      })
    ) {
      reasons.push("blockade");
    }

    if (reasons.length > 0) {
      relations.push({
        attacker: side,
        target: targetSide,
        reasons,
        targetPieceIds: targetPieceIds.sort((left, right) => left - right),
        pendingSides: sides.filter((candidate) => candidate !== side),
      });
    }
  }
  return relations;
}

export function getLegalMovesWithAttacks(
  state: FourShogiState,
  side: Side,
  ordinaryMoves: readonly OrdinaryMove[],
): OrdinaryMove[] {
  if (!usesAttackRestriction(state) || isInCheck(state, side)) return [...ordinaryMoves];

  const restrictedTargets = sides.filter((target) => {
    if (target === side) return false;
    const otherAttackers = new Set(
      state.attackRelations
        .filter((relation) => relation.target === target && relation.attacker !== side)
        .map((relation) => relation.attacker),
    );
    return otherAttackers.size >= 2;
  });
  if (restrictedTargets.length === 0) return [...ordinaryMoves];

  const classified = ordinaryMoves.map((move) => ({
    move,
    targets: new Set(classifyAttacks(state, side, move).map((relation) => relation.target)),
  }));
  const avoidableTargets = restrictedTargets.filter((target) =>
    classified.some((candidate) => !candidate.targets.has(target)),
  );

  return classified
    .filter(({ move, targets }) =>
      avoidableTargets.every(
        (target) =>
          !targets.has(target) ||
          (isInCheck(move.state, target) && !hasOrdinaryMove(move.state, target)),
      ),
    )
    .map(({ move }) => move);
}

export function updateAttackHistory(
  before: FourShogiState,
  side: Side,
  move: OrdinaryMove,
): Pick<StateBase, "attackRelations" | "recaptureSquares"> {
  if (!usesAttackRestriction(before) || !usesAttackRestriction(move.state)) {
    return { attackRelations: [], recaptureSquares: emptyRecaptureSquares() };
  }

  const newRelations = classifyAttacks(before, side, move);
  const attackRelations: AttackRelation[] = [];
  for (const relation of before.attackRelations) {
    const pendingSides = relation.pendingSides.filter((candidate) => candidate !== side);
    if (pendingSides.length === 0) continue;
    if (
      newRelations.some(
        (newRelation) =>
          newRelation.attacker === relation.attacker && newRelation.target === relation.target,
      )
    ) {
      continue;
    }
    attackRelations.push({ ...relation, pendingSides });
  }
  attackRelations.push(...newRelations);

  const recaptureSquares = {
    south: [...before.recaptureSquares.south],
    west: [...before.recaptureSquares.west],
    north: [...before.recaptureSquares.north],
    east: [...before.recaptureSquares.east],
  };
  recaptureSquares[side] = [];
  if (move.captured) {
    const capturedSide = move.captured.side;
    if (
      !recaptureSquares[capturedSide].some((position) => samePosition(position, move.action.to))
    ) {
      recaptureSquares[capturedSide].push({ ...move.action.to });
    }
  }
  return { attackRelations, recaptureSquares };
}
