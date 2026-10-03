import type { Hand, HandPieceKind } from "@tetraboard/four-shogi";
import type { MouseEvent, PointerEvent } from "react";
import { ShogiPiece, shogiPieceLiftClasses } from "./ShogiPiece";
import { shogiPieceNames, type ShogiPieceDirection } from "./shogiBoardPresentation";

export function FourShogiHand({
  hand,
  label,
  direction,
  vertical = false,
  selectedKind,
  availableKinds,
  draggingKind,
  onSelect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: {
  hand: Hand;
  label: string;
  direction: ShogiPieceDirection;
  vertical?: boolean;
  selectedKind: HandPieceKind | null;
  availableKinds: readonly HandPieceKind[];
  draggingKind: HandPieceKind | null;
  onSelect: (kind: HandPieceKind, event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, kind: HandPieceKind) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
}) {
  const order: readonly HandPieceKind[] =
    direction === "up" || direction === "right"
      ? ["pawn", "silver", "gold", "rook"]
      : ["rook", "gold", "silver", "pawn"];
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="shogi-hand"
      data-hand-direction={direction}
      className={`flex ${vertical ? "flex-col min-w-[calc(var(--shogi-piece-width)_+_14px)] min-h-[calc(4_*_var(--shogi-piece-width)_*_148_/_140_+_38px)]" : "flex-row justify-center min-w-[calc(4_*_var(--shogi-piece-width)_+_38px)] min-h-[calc(var(--shogi-piece-width)_*_148_/_140_+_14px)]"} [@media(max-width:767px)]:w-full [@media(max-width:767px)]:min-h-[calc(var(--shogi-piece-width)_*_148_/_140_+_6px)] gap-[2px] rounded-[6px] border border-solid border-[#a77b37] bg-[#d9b676] p-[3px] [@media(max-width:767px)]:py-px shadow-[inset_0_1px_3px_#72451020] bg-[repeating-linear-gradient(95deg,#8c582915_0px,#8c582915_1px,transparent_1px,transparent_7px)]`}
    >
      {order.map((kind) => {
        const count = hand[kind];
        if (count === 0) return null;
        const available = availableKinds.includes(kind);
        const selected = selectedKind === kind;
        return (
          <button
            key={kind}
            type="button"
            disabled={!available}
            aria-label={`${label}、${shogiPieceNames[kind]}${count}枚${available ? "、選択できます" : ""}`}
            aria-pressed={selected}
            data-hand-kind={kind}
            data-dragging={draggingKind === kind || undefined}
            className={`group/shogi-piece relative grid shrink-0 place-items-center w-[calc(var(--shogi-piece-width)_+_6px)] h-[calc(var(--shogi-piece-width)_*_148_/_140_+_6px)] [@media(max-width:767px)]:h-[calc(var(--shogi-piece-width)_*_148_/_140_+_2px)] p-0 rounded-[4px] border-0 bg-transparent focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-[-2px] ${available ? "touch-none cursor-pointer enabled:hover:bg-[#fff6d16b]" : "touch-auto cursor-default"}${selected ? " ring-2 ring-inset ring-[#bd7d10] bg-[#ffe3919c]" : ""}`}
            onClick={(event) => onSelect(kind, event)}
            onPointerDown={(event) => onPointerDown(event, kind)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={onLostPointerCapture}
          >
            <span
              className={
                draggingKind === kind ? "invisible" : available ? shogiPieceLiftClasses : ""
              }
            >
              <ShogiPiece kind={kind} direction={direction} />
            </span>
            {count >= 2 && (
              <span
                aria-hidden="true"
                className="absolute top-[-1px] right-[-1px] grid min-w-[15px] h-[15px] place-items-center rounded-full bg-[#785315] px-[2px] text-[10px] leading-none font-bold text-white tabular-nums"
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
