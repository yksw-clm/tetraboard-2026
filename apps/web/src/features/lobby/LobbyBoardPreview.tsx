import type { GameId } from "@tetraboard/protocol/games";
import { cn } from "@heroui/react";
import fourReversi from "../../assets/lobby/four-reversi.webp";
import reversi from "../../assets/lobby/reversi.webp";
import fourShogi from "../../assets/lobby/four-shogi.webp";
import shogi from "../../assets/lobby/shogi.webp";
import gomoku from "../../assets/lobby/gomoku.webp";

const boards = {
  "four-reversi": { src: fourReversi, width: 264, height: 264, style: "reversi" },
  reversi: { src: reversi, width: 264, height: 264, style: "reversi" },
  "four-shogi": { src: fourShogi, width: 229, height: 250, style: "shogi" },
  shogi: { src: shogi, width: 229, height: 250, style: "shogi" },
  gomoku: { src: gomoku, width: 264, height: 264, style: "gomoku" },
  "four-gomoku": { src: gomoku, width: 264, height: 264, style: "gomoku" },
} as const satisfies Record<GameId, { src: string; width: number; height: number; style: string }>;

const boardStyles = {
  reversi: "rounded-lg shadow-[4px_7px_12px_#32694a22] -rotate-7",
  shogi: "shadow-[4px_7px_12px_#71531c22] -rotate-7",
  gomoku: "rounded-md shadow-md -rotate-6",
};

export function LobbyBoardPreview({
  game,
  compact = false,
  className,
  src,
}: {
  game: GameId;
  compact?: boolean;
  className?: string;
  src?: string;
}) {
  const board = boards[game];
  return (
    <img
      aria-hidden="true"
      data-testid="lobby-board-preview"
      src={src ?? board.src}
      alt=""
      width={board.width}
      height={board.height}
      decoding="async"
      draggable={false}
      className={cn(
        "block h-auto shrink-0 pointer-events-none select-none",
        compact ? "w-16" : "w-[88px] [@media(max-width:767px)]:w-[56px]",
        boardStyles[board.style],
        className,
      )}
    />
  );
}
