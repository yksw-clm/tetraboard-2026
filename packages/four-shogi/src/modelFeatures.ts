import { getAnalysisLegalActions, type AnalysisPosition } from "./analysis";
import { encodeAction } from "./actionEncoding";
import { positionKey } from "./repetition";
import { sides, type Side } from "./types";

export const featureVersion = "four-shogi-features-v1";
export const positionFeatureSize = 4462;
export const historyFeatureSize = positionFeatureSize + 1;
export const currentFeatureSize = positionFeatureSize + 19;
export const maxHistoryEntries = 2048;
export type SparseFeatures = { indices: number[]; values: number[] };
export type ModelFeatures = { current: SparseFeatures; history: SparseFeatures[] };
const pieceKinds = ["king", "rook", "gold", "silver", "pawn", "dragon", "promotedSilver", "tokin"];
const attackReasons = ["check", "capture", "threat", "blockade"];
type Key = [
  ([Side, string, boolean] | null)[][],
  [Side, number[]][],
  Side[],
  Side | null,
  [Side, Side, string[], number[], Side[]][],
  number[][],
];

/** 千日手キーの全盤面・攻撃・取り返しを数値化し、キーのhashだけで履歴を代用しません。 */
function encodeKey(key: string): SparseFeatures {
  const [board, hands, active, turn, attacks, recaptures] = JSON.parse(key) as Key;
  const values = new Map<number, number>();
  const put = (index: number, value = 1) => {
    if (value) values.set(index, value);
  };
  board.flat().forEach((piece, square) => {
    let channel = 0;
    if (piece) {
      const [side, kind, promoted] = piece;
      const name = !promoted
        ? kind
        : kind === "rook"
          ? "dragon"
          : kind === "silver"
            ? "promotedSilver"
            : "tokin";
      channel = 1 + sides.indexOf(side) * 8 + pieceKinds.indexOf(name);
    }
    put(square * 33 + channel);
  });
  for (const [side, hand] of hands)
    hand.forEach((count, kind) => put(2673 + sides.indexOf(side) * 4 + kind, count / 36));
  for (const side of active) put(2689 + sides.indexOf(side));
  put(2693 + (turn === null ? 4 : sides.indexOf(turn)));
  for (const [attacker, target, reasons, targets, pending] of attacks) {
    const base = 2698 + (sides.indexOf(attacker) * 4 + sides.indexOf(target)) * 90;
    put(base);
    for (const reason of reasons) put(base + 1 + attackReasons.indexOf(reason));
    for (const side of pending) put(base + 5 + sides.indexOf(side));
    for (const square of targets) put(base + 9 + square);
  }
  recaptures.forEach((squares, side) => {
    for (const square of squares) put(4138 + side * 81 + square);
  });
  const indices = [...values.keys()].sort((a, b) => a - b);
  return { indices, values: indices.map((i) => values.get(i)!) };
}

export function encodeModelFeatures(position: AnalysisPosition): ModelFeatures {
  getAnalysisLegalActions(position);
  const state = position.state;
  const keys = Object.keys(state.repetitions).sort();
  if (keys.length > maxHistoryEntries)
    throw new RangeError("特徴版1の反復履歴上限を超えています。切り捨てずに拒否します");
  const current = encodeKey(positionKey(state));
  const extra = [
    Number(state.threePlayerAttackProhibited),
    ...sides.map((side) => Number(state.drawProposals.includes(side))),
    ...sides.map((side) => (state.eliminations.find((e) => e.side === side)?.rank ?? 0) / 4),
    ...sides.map((side) => (state.eliminations.find((e) => e.side === side)?.group ?? 0) / 4),
    state.moveNumber / 2000,
    state.lastMove ? (encodeAction(state.lastMove.action) + 1) / 13446 : 0,
    ...sides.map((side) => Number(state.lastMove?.side === side)),
  ];
  extra.forEach((value, i) => {
    if (value) {
      current.indices.push(positionFeatureSize + i);
      current.values.push(value);
    }
  });
  return {
    current,
    history: keys.map((key) => {
      const feature = encodeKey(key);
      feature.indices.push(positionFeatureSize);
      feature.values.push(state.repetitions[key] / 4);
      return feature;
    }),
  };
}
