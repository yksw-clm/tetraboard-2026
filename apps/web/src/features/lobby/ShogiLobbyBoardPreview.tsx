import { createInitialState } from "@tetraboard/shogi";
import { ShogiBoardPreview } from "./ShogiBoardPreview";
const initial = createInitialState({ players: { south: "preview-south", north: "preview-north" } });
export function ShogiLobbyBoardPreview({ compact = false }: { compact?: boolean }) {
  return <ShogiBoardPreview board={initial.board} compact={compact} />;
}
