import { getCheckState, forwardForSide, inBounds } from "./board";
import { getLegalActions } from "./index";
import { hasOrdinaryMove } from "./moves";
import { recordPosition } from "./repetition";
import { AnalysisInputError } from "./analysisInput";
import {
  handPieceKinds,
  sides,
  type Cell,
  type FourShogiState,
  type Hands,
  type PieceKind,
  type Side,
} from "./types";

export type AnalysisSetupInput = Readonly<{
  schemaVersion: 1;
  board: readonly (readonly (Readonly<{
    side: Side;
    kind: PieceKind;
    promoted: boolean;
  }> | null)[])[];
  hands: Hands;
  turn: Side;
  threePlayerAttackProhibited: boolean;
  eliminations: readonly Readonly<{ side: Side; rank: number; group: number }>[];
}>;

function invalid(message: string): never {
  throw new AnalysisInputError("invalid_input", message);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("設定オブジェクトが必要です");
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid(`設定項目を確認してください: ${keys.join(", ")}`);
  return value as Record<string, unknown>;
}
function direction(value: unknown): Side {
  if (!sides.some((side) => side === value)) invalid("担当方向が不正です");
  return value as Side;
}

/** 編集は新しい履歴の起点です。外部の完全状態や攻撃履歴を信頼せず再構成します。 */
export function readAnalysisSetup(input: unknown): {
  setup: AnalysisSetupInput;
  state: FourShogiState;
} {
  const raw = object(input, [
    "schemaVersion",
    "board",
    "hands",
    "turn",
    "threePlayerAttackProhibited",
    "eliminations",
  ]);
  if (raw.schemaVersion !== 1) invalid("盤面編集の版は1のみ対応しています");
  if (typeof raw.threePlayerAttackProhibited !== "boolean") invalid("三人攻撃禁止の指定が必要です");
  const turn = direction(raw.turn);
  if (!Array.isArray(raw.eliminations) || raw.eliminations.length > 2)
    invalid("生存者は2〜4人にしてください");
  const eliminations = raw.eliminations
    .map((value) => {
      const item = object(value, ["side", "rank", "group"]);
      if (!Number.isSafeInteger(item.rank) || !Number.isSafeInteger(item.group))
        invalid("順位と脱落組は整数です");
      return { side: direction(item.side), rank: item.rank as number, group: item.group as number };
    })
    .sort((a, b) => a.group - b.group || sides.indexOf(a.side) - sides.indexOf(b.side));
  const eliminated = new Set(eliminations.map((item) => item.side));
  if (eliminated.size !== eliminations.length || eliminated.has(turn))
    invalid("脱落者の重複・手番を確認してください");
  let count = 0;
  for (let group = 1; count < eliminations.length; group++) {
    const entries = eliminations.filter((item) => item.group === group);
    if (entries.length === 0) invalid("脱落組は1から連続させてください");
    count += entries.length;
    if (entries.some((item) => item.rank !== 5 - count))
      invalid("脱落順・同時脱落と順位が一致しません");
  }
  const totals = { king: 0, rook: 0, gold: 0, silver: 0, pawn: 0 };
  const kings = { south: 0, west: 0, north: 0, east: 0 };
  const kingSquares: { side: Side; x: number; y: number }[] = [];
  const pawnFiles = new Set<string>();
  if (!Array.isArray(raw.board) || raw.board.length !== 9) invalid("盤は9×9です");
  let nextPieceId = 1;
  const board: Cell[][] = raw.board.map((row, y) => {
    if (!Array.isArray(row) || row.length !== 9) invalid("盤は9×9です");
    return row.map((value, x): Cell => {
      if (value === null) return null;
      const piece = object(value, ["side", "kind", "promoted"]);
      const side = direction(piece.side);
      if (!["king", ...handPieceKinds].some((kind) => kind === piece.kind))
        invalid("駒種が不正です");
      const kind = piece.kind as PieceKind;
      if (
        typeof piece.promoted !== "boolean" ||
        (piece.promoted && (kind === "king" || kind === "gold"))
      )
        invalid("成り指定が不正です");
      totals[kind]++;
      if (kind === "king") {
        kings[side]++;
        if (!eliminated.has(side)) kingSquares.push({ side, x, y });
      }
      if (kind === "pawn" && !piece.promoted && !eliminated.has(side)) {
        const forward = forwardForSide(side);
        if (!inBounds({ x: x + forward.x, y: y + forward.y })) invalid("行き所のない歩があります");
        const file = `${side}:${forward.x === 0 ? x : y}`;
        if (pawnFiles.has(file)) invalid("二歩があります");
        pawnFiles.add(file);
      }
      return { id: nextPieceId++, side, kind, promoted: piece.promoted };
    });
  });
  if (sides.some((side) => kings[side] !== 1))
    invalid("脱落した裏王を含め、各方向の玉を1枚ずつ置いてください");
  // 通常の合法な着手では作れない相互王手を、自由編集から持ち込みません。
  for (const [index, king] of kingSquares.entries())
    if (
      kingSquares
        .slice(index + 1)
        .some((other) => Math.max(Math.abs(king.x - other.x), Math.abs(king.y - other.y)) <= 1)
    )
      invalid("生存する玉同士を隣接させることはできません");
  const rawHands = object(raw.hands, sides);
  const hands = {} as Record<Side, Record<(typeof handPieceKinds)[number], number>>;
  for (const side of sides) {
    const hand = object(rawHands[side], handPieceKinds);
    hands[side] = { rook: 0, gold: 0, silver: 0, pawn: 0 };
    for (const kind of handPieceKinds) {
      const count = hand[kind];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 12)
        invalid("持ち駒数が不正です");
      if (eliminated.has(side) && count !== 0) invalid("脱落者の持ち駒は0です");
      hands[side][kind] = count;
      totals[kind] += count;
    }
  }
  if (totals.rook > 4 || totals.gold > 8 || totals.silver > 8 || totals.pawn > 12)
    invalid("盤上と持ち駒の合計が初期の駒数を超えています");
  const state: FourShogiState = {
    rulesVersion: 1,
    mode: "singles",
    players: { south: "study-south", west: "study-west", north: "study-north", east: "study-east" },
    threePlayerAttackProhibited: raw.threePlayerAttackProhibited,
    board,
    hands,
    status: "playing",
    turn,
    result: null,
    eliminations: eliminations.map((entry) => ({ ...entry, reason: "resigned" })),
    drawProposals: [],
    attackRelations: [],
    recaptureSquares: { south: [], west: [], north: [], east: [] },
    repetitions: {},
    nextPieceId,
    moveNumber: 0,
    lastMove: null,
  };
  const checks = getCheckState(state);
  const checked = sides.filter((side) => !eliminated.has(side) && checks[side]);
  if (checked.length > 0 && !checked.includes(turn))
    invalid("王手されている人を手番にしてください");
  if (checked.some((side) => !hasOrdinaryMove(state, side)) || getLegalActions(state).length === 0)
    invalid("既に詰み・合法手なしの局面です。脱落状態を設定してください");
  return {
    setup: {
      schemaVersion: 1,
      board: board.map((row) =>
        row.map((piece) =>
          piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
        ),
      ),
      hands,
      turn,
      threePlayerAttackProhibited: raw.threePlayerAttackProhibited,
      eliminations,
    },
    state: recordPosition(state),
  };
}
