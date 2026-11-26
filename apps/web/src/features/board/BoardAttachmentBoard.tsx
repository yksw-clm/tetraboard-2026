import { gameCatalog } from "@tetraboard/protocol/games";
import { FourReversiBoard } from "../room/FourReversiBoard";
import { FourShogiBoardLayout } from "../room/FourShogiBoardLayout";
import { GomokuBoard } from "../room/GomokuBoard";
import type { BoardAttachmentFrame } from "./boardAttachmentFrames";

export function BoardAttachmentBoard({ game, frame }: BoardAttachmentFrame) {
  switch (game) {
    case "four-reversi":
    case "reversi":
      return (
        <FourReversiBoard
          label={`${gameCatalog[game].name}の盤面`}
          game={frame.game}
          legalMoves={[]}
          canPlay={false}
          onPlaceStone={() => {}}
        />
      );
    case "four-gomoku":
    case "gomoku":
      return (
        <GomokuBoard
          label={`${gameCatalog[game].name}の盤面`}
          game={frame.game}
          canPlay={false}
          onPlaceStone={() => {}}
        />
      );
    case "shogi":
    case "four-shogi":
      return (
        <div className="size-full [container-type:size] [&>div]:[--shogi-board-width:73cqw] [&>div]:[--shogi-side-width:calc(13cqw-8px)] [&>div]:gap-0 [&>div]:py-0">
          <FourShogiBoardLayout
            standard={game === "shogi"}
            game={frame.game}
            viewerSide="south"
            revision={frame.label}
            eliminatedHands={game === "four-shogi" ? frame.eliminatedHands : undefined}
            checkState={frame.checkState}
            playerCards={{}}
            legalActions={[]}
            canPlay={false}
            onAction={() => {}}
          />
        </div>
      );
  }
}
