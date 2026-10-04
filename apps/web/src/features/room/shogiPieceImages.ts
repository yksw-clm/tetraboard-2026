import type { HandPieceKind, PieceKind } from "@tetraboard/four-shogi";
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
  king: "王",
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
) {
  const sprite =
    kind === "king" && deadKing
      ? "deadKing"
      : promoted && kind === "rook"
        ? "dragon"
        : promoted && kind === "silver"
          ? "promotedSilver"
          : promoted && kind === "pawn"
            ? "promotedPawn"
            : kind;
  return { src: sprites[direction === "down" ? "down" : "up"][sprite], name: names[sprite] };
}
// Promiseに成功したImageを保持し、同じページの再戦・棋譜・回転でも再利用します。
const prepared = new Map<string, Promise<HTMLImageElement | null>>();
let preparation: Promise<void> | undefined;
function prepare(src: string): Promise<HTMLImageElement | null> {
  const existing = prepared.get(src);
  if (existing) return existing;
  const image = new Image();
  image.fetchPriority = "low";
  image.src = src;
  const result = image.decode().then(
    () => image,
    () => null,
  );
  prepared.set(src, result);
  return result;
}
export function prepareShogiPieceImages(): Promise<void> {
  if (preparation) return preparation;
  const urls = [
    upPromotedSilver,
    upDragon,
    upDeadKing,
    downPromotedSilver,
    downDragon,
    downDeadKing,
  ];
  let next = 0;
  async function worker() {
    while (next < urls.length) await prepare(urls[next++]!);
  }
  // 失敗も完了として扱い、表示を妨げず自動再試行を繰り返しません。
  preparation = Promise.all([worker(), worker()]).then(() => {});
  return preparation;
}
