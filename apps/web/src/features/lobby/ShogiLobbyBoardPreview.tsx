import { createInitialState } from "@tetraboard/shogi";
import { ShogiBoardPreview } from "./ShogiBoardPreview";
const initial = createInitialState({ players: { south: "preview-south", north: "preview-north" } });
export function ShogiLobbyBoardPreview() {
  return <ShogiBoardPreview board={initial.board} />;
}
