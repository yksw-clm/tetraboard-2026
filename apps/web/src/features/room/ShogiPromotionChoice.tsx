import type { FourShogiAction, PieceKind, Side } from "./shogiUiTypes";
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ShogiPiece } from "./ShogiPiece";
import { shogiDisplayPosition, shogiPieceDirection } from "./shogiBoardPresentation";

export function ShogiPromotionChoice({
  choices,
  kind,
  viewerSide,
  grid,
  onChoose,
}: {
  choices: Extract<FourShogiAction, { type: "movePiece" }>[];
  kind: PieceKind;
  viewerSide: Side;
  grid: RefObject<HTMLDivElement | null>;
  onChoose: (action: Extract<FourShogiAction, { type: "movePiece" }>) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>();
  const { x, y } = shogiDisplayPosition(choices[0].to, viewerSide);
  useLayoutEffect(() => {
    function place(): void {
      if (!grid.current) return;
      const bounds = grid.current.getBoundingClientRect();
      const pieceWidth = (bounds.width / 9) * 0.82;
      const width = 2 * (pieceWidth + 8) + 4;
      const height = (pieceWidth * 148) / 140 + 8;
      setPlacement({
        left:
          bounds.left +
          Math.max(0, Math.min(bounds.width - width, ((x + 0.5) * bounds.width) / 9 - width / 2)),
        top:
          bounds.top +
          Math.max(
            0,
            Math.min(bounds.height - height, ((y + 0.5) * bounds.height) / 9 - height / 2),
          ),
        "--shogi-piece-width": `${pieceWidth}px`,
      } as CSSProperties);
    }
    place();
    const observer = new ResizeObserver(place);
    if (grid.current) observer.observe(grid.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [grid, x, y]);
  const placed = placement !== undefined;
  useLayoutEffect(() => {
    if (placed) menu.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [placed]);
  const ordered = [...choices].sort((a, b) => Number(b.promote) - Number(a.promote));
  return createPortal(
    <div className="fixed inset-0 z-[120]">
      <button
        type="button"
        tabIndex={-1}
        aria-label="成りを確定"
        className="absolute inset-0 size-full border-0 bg-transparent p-0 cursor-pointer"
        onClick={() => onChoose(ordered[0])}
      />
      <div
        ref={menu}
        role="group"
        aria-label="成りの選択"
        className="fixed flex gap-1"
        style={placement ?? { visibility: "hidden" }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll("button")];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        }}
      >
        {ordered.map((action) => (
          <button
            key={String(action.promote)}
            type="button"
            aria-label={action.promote ? "成る" : "成らない"}
            className={`box-border grid place-items-center border border-solid border-[#9c6f14] p-[3px] shadow-[0_3px_8px_#54361880] cursor-pointer focus-visible:outline-[3px] focus-visible:outline-[#ffe650] focus-visible:outline-offset-1 ${action.promote ? "bg-gradient-to-b from-[#fff0a8] to-[#b87810]" : "bg-gradient-to-b from-[#f8edc9] to-[#655231]"}`}
            onClick={() => onChoose(action)}
          >
            <ShogiPiece
              kind={kind}
              promoted={action.promote}
              direction={shogiPieceDirection(viewerSide, viewerSide)}
            />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
