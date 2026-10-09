import downLance from "../../assets/shogi/down/down_lance.png";
import downPromotedLance from "../../assets/shogi/down/down_prom_lance.png";
import downKnight from "../../assets/shogi/down/down_knight.png";
import downPromotedKnight from "../../assets/shogi/down/down_prom_knight.png";
import downBishop from "../../assets/shogi/down/down_bishop.png";
import downPromotedBishop from "../../assets/shogi/down/down_prom_bishop.png";
import downRoyalKing from "../../assets/shogi/down/down_king.png";
import upLance from "../../assets/shogi/up/up_lance.png";
import upPromotedLance from "../../assets/shogi/up/up_prom_lance.png";
import upKnight from "../../assets/shogi/up/up_knight.png";
import upPromotedKnight from "../../assets/shogi/up/up_prom_knight.png";
import upBishop from "../../assets/shogi/up/up_bishop.png";
import upPromotedBishop from "../../assets/shogi/up/up_prom_bishop.png";
import upRoyalKing from "../../assets/shogi/up/up_king.png";
import boardImage from "../../assets/shogi/board.png";
import { createShogiImageStore } from "./shogiImageStore";
import type { HandPieceKind, PieceKind } from "./shogiUiTypes";
import upKing from "../../assets/shogi/up/up_king2.png";
import upDeadKing from "../../assets/shogi/up/up_dead_king2.png";
import upRook from "../../assets/shogi/up/up_rook.png";
import upDragon from "../../assets/shogi/up/up_prom_rook.png";
import upGold from "../../assets/shogi/up/up_gold.png";
import upSilver from "../../assets/shogi/up/up_silver.png";
import upPromotedSilver from "../../assets/shogi/up/up_prom_silver.png";
import upPawn from "../../assets/shogi/up/up_pawn.png";
import upPromotedPawn from "../../assets/shogi/up/up_prom_pawn.png";
import downKing from "../../assets/shogi/down/down_king2.png";
import downDeadKing from "../../assets/shogi/down/down_dead_king2.png";
import downRook from "../../assets/shogi/down/down_rook.png";
import downDragon from "../../assets/shogi/down/down_prom_rook.png";
import downGold from "../../assets/shogi/down/down_gold.png";
import downSilver from "../../assets/shogi/down/down_silver.png";
import downPromotedSilver from "../../assets/shogi/down/down_prom_silver.png";
import downPawn from "../../assets/shogi/down/down_pawn.png";
import downPromotedPawn from "../../assets/shogi/down/down_prom_pawn.png";
import type { ShogiPieceDirection } from "./shogiBoardPresentation";

const sprites = {
  up: {
    king: upKing,
    royalKing: upRoyalKing,
    bishop: upBishop,
    promotedBishop: upPromotedBishop,
    knight: upKnight,
    promotedKnight: upPromotedKnight,
    lance: upLance,
    promotedLance: upPromotedLance,
    deadKing: upDeadKing,
    rook: upRook,
    dragon: upDragon,
    gold: upGold,
    silver: upSilver,
    promotedSilver: upPromotedSilver,
    pawn: upPawn,
    promotedPawn: upPromotedPawn,
  },
  down: {
    king: downKing,
    royalKing: downRoyalKing,
    bishop: downBishop,
    promotedBishop: downPromotedBishop,
    knight: downKnight,
    promotedKnight: downPromotedKnight,
    lance: downLance,
    promotedLance: downPromotedLance,
    deadKing: downDeadKing,
    rook: downRook,
    dragon: downDragon,
    gold: downGold,
    silver: downSilver,
    promotedSilver: downPromotedSilver,
    pawn: downPawn,
    promotedPawn: downPromotedPawn,
  },
};
const names = {
  king: "玉",
  royalKing: "王",
  bishop: "角",
  promotedBishop: "馬",
  knight: "桂",
  promotedKnight: "成桂",
  lance: "香",
  promotedLance: "成香",
  deadKing: "裏王",
  rook: "飛",
  dragon: "龍",
  gold: "金",
  silver: "銀",
  promotedSilver: "成銀",
  pawn: "歩",
  promotedPawn: "と金",
};
export function shogiPieceImage(
  kind: PieceKind | HandPieceKind,
  promoted: boolean,
  deadKing: boolean,
  direction: ShogiPieceDirection,
  royalKing = false,
) {
  const sprite =
    kind === "king" && deadKing
      ? "deadKing"
      : kind === "king" && royalKing
        ? "royalKing"
        : promoted && kind === "bishop"
          ? "promotedBishop"
          : promoted && kind === "knight"
            ? "promotedKnight"
            : promoted && kind === "lance"
              ? "promotedLance"
              : promoted && kind === "rook"
                ? "dragon"
                : promoted && kind === "silver"
                  ? "promotedSilver"
                  : promoted && kind === "pawn"
                    ? "promotedPawn"
                    : kind;
  return { src: sprites[direction === "down" ? "down" : "up"][sprite], name: names[sprite] };
}
export const shogiImageStore = createShogiImageStore();
const fourSpriteKeys = [
  "king",
  "deadKing",
  "rook",
  "dragon",
  "gold",
  "silver",
  "promotedSilver",
  "pawn",
  "promotedPawn",
] as const;
export function prepareShogiAssets(standard = false): Promise<void> {
  const urls = [
    boardImage,
    ...(["up", "down"] as const).flatMap((direction) =>
      standard
        ? Object.entries(sprites[direction])
            .filter(([key]) => key !== "deadKing")
            .map(([, src]) => src)
        : fourSpriteKeys.map((key) => sprites[direction][key]),
    ),
  ];
  return Promise.all(urls.map((src) => shogiImageStore.prepare(src))).then(() => {});
}
