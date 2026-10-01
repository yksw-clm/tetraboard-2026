import { Button } from "@heroui/react";
import { type FourReversiState, type Position } from "@tetraboard/four-reversi";
import { colorNames } from "./roomPresentation";

export function FourReversiBoard({
  game,
  legalMoves,
  canPlay,
  onPlaceStone,
}: {
  game: FourReversiState;
  legalMoves: Position[];
  canPlay: boolean;
  onPlaceStone: (position: Position) => void;
}) {
  return (
    <div className="room-board" role="group" aria-label="四人リバーシの盤面">
      {game.board.flatMap((row, y) =>
        row.map((cell, x) => {
          const legal = canPlay && legalMoves.some((move) => move.x === x && move.y === y);
          const lastMove = game.lastMove?.x === x && game.lastMove?.y === y;
          return (
            <Button
              key={`${x}-${y}`}
              isIconOnly
              className={`room-cell${lastMove ? " is-last-move" : ""}`}
              aria-label={`${"ABCDEFGH"[x]}${y + 1}：${cell ? colorNames[cell] : "空き"}${legal ? "、置けます" : ""}${lastMove ? "、直前の手" : ""}`}
              isDisabled={!legal}
              onPress={() => onPlaceStone({ x, y })}
            >
              {cell && <span className={`room-stone room-stone-${cell}`} />}
              {legal && <span className="room-legal" aria-hidden="true" />}
            </Button>
          );
        }),
      )}
    </div>
  );
}
