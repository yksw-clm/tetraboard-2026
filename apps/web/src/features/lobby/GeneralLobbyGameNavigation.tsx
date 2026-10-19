import type { GameId } from "@tetraboard/protocol/games";
import type { ReactNode } from "react";
import { GameLobbyNavigation } from "./GameLobbyNavigation";
import { LobbyBoardPreview } from "./LobbyBoardPreview";

const previews = {
  "four-reversi": <LobbyBoardPreview game="four-reversi" compact />,
  "four-shogi": <LobbyBoardPreview game="four-shogi" compact />,
  reversi: <LobbyBoardPreview game="reversi" compact />,
  shogi: <LobbyBoardPreview game="shogi" compact />,
  gomoku: <LobbyBoardPreview game="gomoku" compact />,
  "four-gomoku": <LobbyBoardPreview game="four-gomoku" compact />,
} satisfies Record<GameId, ReactNode>;

export function GeneralLobbyGameNavigation() {
  return <GameLobbyNavigation previews={previews} />;
}
