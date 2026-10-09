import type { Board } from "../room/shogiUiTypes";
import boardImage from "../../assets/shogi/board.png";
import { ShogiPiece } from "../room/ShogiPiece";
import { shogiPieceDirection } from "../room/shogiBoardPresentation";

export function ShogiBoardPreview({ board }: { board: Board }) {
  return (
    <div
      aria-hidden="true"
      data-testid="lobby-board-preview"
      className="relative shrink-0 [--shogi-board-width:88px] [@media(max-width:767px)]:[--shogi-board-width:56px] w-[var(--shogi-board-width)] aspect-[458/500] [--shogi-piece-width:calc(var(--shogi-board-width)_*_446_/_458_/_9_*_0.82)] shadow-[4px_7px_12px_#71531c22] -rotate-7 pointer-events-none select-none"
    >
      <img src={boardImage} alt="" draggable={false} className="absolute inset-0 block size-full" />
      <div className="absolute inset-x-[1.3100437%] inset-y-[1.2%] grid grid-cols-9 grid-rows-9">
        {board.flat().map((piece, index) => (
          <span className="grid place-items-center min-w-0 min-h-0" key={index}>
            {piece && (
              <ShogiPiece
                royalKing={
                  piece.side === "south" &&
                  piece.kind === "king" &&
                  board.flat().filter((p) => p?.kind === "king").length === 2
                }
                kind={piece.kind}
                direction={shogiPieceDirection(piece.side, "south")}
              />
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
