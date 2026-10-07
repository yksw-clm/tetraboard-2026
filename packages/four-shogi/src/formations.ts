import { positionForSide } from "./board";
import type { FourShogiState, PieceKind, Position, Side } from "./types";

export const formationAnalyzerId = "four-shogi-formations";
export const formationAnalysisVersion = 2;
export type FormationPosition = Pick<FourShogiState, "rulesVersion" | "board" | "eliminations">;

const definitions = [
  {
    id: "tenshukaku",
    name: "天守閣玉",
    king: "E7",
    rook: "E8",
    gold: ["D9", "F9"],
    silver: ["C9", "G9"],
    pawn: ["D7", "E6", "F7"],
  },
  {
    id: "subway-rook",
    name: "地下鉄飛車",
    king: "F8",
    rook: "E9",
    gold: ["F9", "G8"],
    silver: ["C9", "G9"],
    pawn: ["D8", "E7", "F7"],
  },
  {
    id: "right-king",
    name: "右玉",
    king: "I9",
    rook: "E8",
    gold: ["D9", "H9"],
    silver: ["C9", "I8"],
    pawn: ["D8", "E7", "F7"],
  },
  {
    id: "e-shape",
    name: "エの字",
    king: "E9",
    rook: "E8",
    gold: ["D9", "F9"],
    silver: ["C9", "G9"],
    pawn: ["D7", "E7", "F7"],
  },
  {
    id: "riggtosfar",
    name: "リッグトスファー",
    king: "E8",
    rook: "F9",
    gold: ["D9", "G8"],
    silver: ["D8", "G9"],
    pawn: ["D7", "E7", "F6"],
  },
  {
    id: "floating-rook",
    name: "浮き飛車",
    king: "F8",
    rook: "E7",
    gold: ["C8", "F9"],
    silver: ["C9", "G9"],
    pawn: ["D8", "E6", "F7"],
  },
  {
    id: "tenshukaku-subway",
    name: "天守閣地下鉄",
    king: "E7",
    rook: "E9",
    gold: ["D9", "G8"],
    silver: ["C9", "G9"],
    pawn: ["D7", "E6", "F7"],
  },
  {
    id: "tenshukaku-ship",
    name: "天守閣シップ",
    king: "E7",
    rook: "E8",
    gold: ["E9", "F9"],
    silver: ["D8", "G9"],
    pawn: ["D7", "E6", "F7"],
  },
  {
    id: "batto-silver",
    name: "抜刀銀",
    king: "E7",
    rook: "E8",
    gold: ["D9", "F9"],
    silver: ["C9", "D8"],
    pawn: ["D7", "E6", "F7"],
  },
  {
    // 連盟記事では地下鉄飛車と同じ完成図を参照しています。
    id: "lower-gold",
    name: "下段金寄せ",
    king: "F8",
    rook: "E9",
    gold: ["F9", "G8"],
    silver: ["C9", "G9"],
    pawn: ["D8", "E7", "F7"],
  },
  {
    id: "yuzuu-muge",
    name: "融通無碍",
    king: "F9",
    rook: "E9",
    gold: ["C8", "H8"],
    silver: ["D8", "G9"],
    pawn: ["D7", "E6", "F7"],
  },
  {
    id: "one-watch-rook",
    name: "１見飛車",
    king: "E9",
    rook: "A8",
    gold: ["D9", "F9"],
    silver: ["C9", "G9"],
    pawn: ["D7", "E7", "F7"],
  },
  {
    id: "king-58",
    name: "５八玉型",
    king: "E8",
    rook: "E9",
    gold: ["D9", "F9"],
    silver: ["C9", "G9"],
    pawn: ["D8", "E7", "F7"],
  },
  {
    id: "teni-muho",
    name: "天衣無縫",
    king: "E9",
    rook: "E8",
    gold: ["D9", "G9"],
    silver: ["C9", "H9"],
    pawn: ["D7", "E7", "F7"],
  },
  {
    id: "tempo-riggtosfar",
    name: "１手得リッグトスファー",
    king: "E8",
    rook: "F8",
    gold: ["D9", "G8"],
    silver: ["C9", "G9"],
    pawn: ["D8", "E7", "F6"],
  },
  {
    id: "silver-28-quick-attack",
    name: "２八銀早仕掛け",
    king: "F9",
    rook: "E8",
    gold: ["D9", "G8"],
    silver: ["C9", "H8"],
    pawn: ["D8", "E7", "F7"],
  },
  {
    id: "five",
    name: "ファイブ",
    king: "E9",
    rook: [],
    gold: ["D9", "F9"],
    silver: ["C9", "E8", "G9"],
    pawn: ["D7", "E6", "F7"],
  },
] as const;

export type FormationId = (typeof definitions)[number]["id"];
export const formationIds: readonly FormationId[] = definitions.map((definition) => definition.id);
export type FormationMatch = Readonly<{
  id: FormationId;
  name: string;
  matchedSquares: readonly Position[];
}>;

const patterns = definitions.map((definition) => ({
  id: definition.id,
  name: definition.name,
  pieces: (["king", "rook", "gold", "silver", "pawn"] as const).flatMap((kind) => {
    const squares = definition[kind];
    return (typeof squares === "string" ? [squares] : squares).map((square) => ({
      kind: kind as PieceKind,
      position: { x: square.charCodeAt(0) - 65, y: Number(square[1]) - 1 },
    }));
  }),
}));

/** 確定局面の自駒だけを照合し、ルール状態や解析履歴を変更しません。 */
export function detectFormations(position: FormationPosition, side: Side): FormationMatch[] {
  if (position.rulesVersion !== 1) throw new Error("Unsupported formation rules version");
  if (position.eliminations.some((entry) => entry.side === side)) return [];
  return patterns.flatMap((pattern) => {
    const required = pattern.pieces.map((entry) => ({
      ...entry,
      position: positionForSide(entry.position, side),
    }));
    if (
      !required.every(({ kind, position: square }) => {
        const piece = position.board[square.y][square.x];
        return piece?.side === side && piece.kind === kind && !piece.promoted;
      })
    )
      return [];
    return [
      {
        id: pattern.id,
        name: pattern.name,
        matchedSquares: required.map((entry) => entry.position),
      },
    ];
  });
}
