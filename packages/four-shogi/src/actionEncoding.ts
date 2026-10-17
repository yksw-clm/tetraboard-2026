import { handPieceKinds, type FourShogiAction, type Position, type Side } from "./types";
import { positionForSide } from "./board";
import { readReplayEvent } from "./analysisInput";

export const actionEncodingVersion = "four-shogi-policy-index-v1";
export const actionSpaceSize = 81 * 81 * 2 + 81 * handPieceKinds.length;
const moveCount = 81 * 81 * 2;
const square = ({ x, y }: Position) => y * 9 + x;
const position = (index: number): Position => ({ x: index % 9, y: Math.floor(index / 9) });

/** 成り/不成と打ち駒を別IDにし、合法性は正本から得るマスクで制限します。 */
export function encodeAction(input: FourShogiAction): number {
  const event = readReplayEvent({ type: "action", side: "south", action: input });
  if (event.type !== "action") throw new TypeError("着手が必要です");
  const action = event.action;
  return action.type === "movePiece"
    ? (square(action.from) * 81 + square(action.to)) * 2 + Number(action.promote)
    : moveCount + handPieceKinds.indexOf(action.pieceKind) * 81 + square(action.to);
}

export function decodeAction(id: number): FourShogiAction {
  if (!Number.isSafeInteger(id) || id < 0 || id >= actionSpaceSize)
    throw new TypeError("行動IDは行動空間内の整数です");
  if (id < moveCount) {
    const pair = Math.floor(id / 2);
    return {
      type: "movePiece",
      from: position(Math.floor(pair / 81)),
      to: position(pair % 81),
      promote: id % 2 === 1,
    };
  }
  const drop = id - moveCount;
  return {
    type: "dropPiece",
    pieceKind: handPieceKinds[Math.floor(drop / 81)],
    to: position(drop % 81),
  };
}

export function legalActionMask(ids: readonly number[]): Uint8Array {
  const mask = new Uint8Array(actionSpaceSize);
  for (const id of ids) {
    decodeAction(id);
    if (mask[id]) throw new TypeError("合法手IDが重複しています");
    mask[id] = 1;
  }
  return mask;
}

/** 方向の対応検査用です。回転した着手が元局面でも合法とは仮定しません。 */
export function rotateAction(action: FourShogiAction, orientation: Side): FourShogiAction {
  encodeAction(action);
  return action.type === "movePiece"
    ? {
        ...action,
        from: positionForSide(action.from, orientation),
        to: positionForSide(action.to, orientation),
      }
    : { ...action, to: positionForSide(action.to, orientation) };
}
