import { boardPositionForDisplay, type QuarterTurn } from "./boardRotation";
import { Stone } from "./Stone";
import { Button } from "@heroui/react";
import type { FourReversiState, Position } from "@tetraboard/four-reversi";
import { colorNames } from "./roomPresentation";

export function FourReversiBoard({
  game,
  legalMoves,
  canPlay,
  onPlaceStone,
  rotation = 0,
}: {
  rotation?: QuarterTurn;
  game: FourReversiState;
  legalMoves: Position[];
  canPlay: boolean;
  onPlaceStone: (position: Position) => void;
}) {
  return (
    <div
      className="[grid-area:board] w-[var(--board-size)] aspect-square place-self-center grid grid-cols-8 grid-rows-8 bg-[#238657] border-2 border-solid border-[#175c3d] rounded-[3px] shadow-[0_10px_25px_#19402a20] overflow-hidden"
      role="group"
      aria-label="四人リバーシの盤面"
    >
      {Array.from({ length: 8 }, (_, displayY) =>
        Array.from({ length: 8 }, (_, displayX) => {
          const { x, y } = boardPositionForDisplay({ x: displayX, y: displayY }, 8, rotation);
          const cell = game.board[y][x];
          const legal = canPlay && legalMoves.some((move) => move.x === x && move.y === y);
          const lastMove = game.lastMove?.x === x && game.lastMove?.y === y;
          return (
            <Button
              key={`${x}-${y}`}
              isIconOnly
              className={`relative grid place-items-center w-full h-full min-w-0 min-h-0 p-0 border-0 border-r border-b border-solid border-[#185c407a] rounded-none bg-transparent text-white transform-none [&:nth-child(8n)]:border-r-0 [&:nth-last-child(-n+8)]:border-b-0 disabled:opacity-100 enabled:cursor-pointer enabled:hover:bg-[#aee5aa35] focus-visible:outline-offset-[-4px] focus-visible:outline-[#fff4a8] focus-visible:z-[1]${lastMove ? " after:content-[''] after:absolute after:inset-0 after:border-[3px] after:border-solid after:border-[#ffad32] after:pointer-events-none" : ""}`}
              aria-label={`${"ABCDEFGH"[x]}${y + 1}：${cell ? colorNames[cell] : "空き"}${legal ? "、置けます" : ""}${lastMove ? "、直前の手" : ""}`}
              isDisabled={!legal}
              onPress={() => onPlaceStone({ x, y })}
            >
              {cell && <Stone color={cell} className="absolute inset-[12%]" />}
              {legal && (
                <span
                  className="absolute block w-[17%] aspect-square rounded-full bg-[#daf1d4a3]"
                  aria-hidden="true"
                />
              )}
            </Button>
          );
        }),
      )}
    </div>
  );
}
