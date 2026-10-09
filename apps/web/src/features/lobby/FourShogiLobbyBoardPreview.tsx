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

export function FourShogiLobbyBoardPreview() {
  return <ShogiBoardPreview board={initialBoard} />;
}
