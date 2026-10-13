import { createInitialState } from "@tetraboard/four-shogi";
import { ShogiBoardPreview } from "./ShogiBoardPreview";
const initialBoard = createInitialState({
  mode: "singles",
  players: {
    south: "preview-south",
    west: "preview-west",
    north: "preview-north",
    east: "preview-east",
  },
}).board;

export function FourShogiLobbyBoardPreview({ compact = false }: { compact?: boolean }) {
  return <ShogiBoardPreview board={initialBoard} compact={compact} />;
}
