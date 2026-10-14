import { createInitialState as createGomoku } from "@tetraboard/gomoku";
import { createInitialState as createFourGomoku } from "@tetraboard/four-gomoku";
import type { GameId } from "@tetraboard/protocol/games";
import type { ReactNode } from "react";
import { GomokuBoard } from "../room/GomokuBoard";
import { GameLobbyNavigation } from "./GameLobbyNavigation";
import { ReversiLobbyBoardPreview } from "./ReversiLobbyBoardPreview";
import { FourShogiLobbyBoardPreview } from "./FourShogiLobbyBoardPreview";
import { ShogiLobbyBoardPreview } from "./ShogiLobbyBoardPreview";

const previews = {
  "four-reversi": <ReversiLobbyBoardPreview fourPlayer compact />,
  "four-shogi": <FourShogiLobbyBoardPreview compact />,
  reversi: <ReversiLobbyBoardPreview fourPlayer={false} compact />,
  shogi: <ShogiLobbyBoardPreview compact />,
  gomoku: (
    <div aria-hidden="true" className="pointer-events-none w-16 -rotate-6">
      <GomokuBoard game={createGomoku()} canPlay={false} onPlaceStone={() => {}} />
    </div>
  ),
  "four-gomoku": (
    <div aria-hidden="true" className="pointer-events-none w-16 -rotate-6">
      <GomokuBoard game={createFourGomoku()} canPlay={false} onPlaceStone={() => {}} />
    </div>
  ),
} satisfies Record<GameId, ReactNode>;

export function GeneralLobbyGameNavigation() {
  return <GameLobbyNavigation previews={previews} />;
}
