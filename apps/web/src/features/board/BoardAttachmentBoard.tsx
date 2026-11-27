import { gameCatalog } from "@tetraboard/protocol/games";
import { FourReversiBoard } from "../room/FourReversiBoard";
import { FourShogiBoardLayout } from "../room/FourShogiBoardLayout";
import { GomokuBoard } from "../room/GomokuBoard";
import type { BoardAttachmentFrame } from "./boardAttachmentFrames";

export function BoardAttachmentBoard(position: BoardAttachmentFrame) {
  const shogi = position.game === "shogi" || position.game === "four-shogi";
  return (
    <div
      className={`pointer-events-none aspect-square min-w-0 [--board-size:100%] [&_[data-hand-kind]>.tabular-nums]:origin-top-right [&_[data-hand-kind]>.tabular-nums]:scale-75 ${shogi ? "[@media(max-width:767px)]:aspect-auto" : ""}`}
    >
      <AttachmentBoard {...position} />
    </div>
  );
}

function AttachmentBoard({ game, frame }: BoardAttachmentFrame) {
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
        <FourShogiBoardLayout
          compact
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
      );
  }
}
