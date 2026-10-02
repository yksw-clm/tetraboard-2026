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
const rotationClasses: Record<ShogiPieceDirection, string> = {
  up: "",
  down: "",
  right: "rotate-90",
  left: "-rotate-90",
};

export function ShogiPiece({
  kind,
  promoted = false,
  deadKing = false,
  direction,
}: {
  kind: PieceKind | HandPieceKind;
  promoted?: boolean;
  deadKing?: boolean;
  direction: ShogiPieceDirection;
}) {
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
  return (
    <img
      src={sprites[direction === "down" ? "down" : "up"][sprite]}
      alt=""
      draggable={false}
      aria-hidden="true"
      data-testid="shogi-piece"
      data-piece-direction={direction}
      className={`block w-[var(--shogi-piece-width)] max-w-none aspect-[140/148] object-contain select-none pointer-events-none ${rotationClasses[direction]}`}
    />
  );
}
