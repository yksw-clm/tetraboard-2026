import type { Side } from "@tetraboard/four-shogi";
import { shogiSides } from "./shogiBoardPresentation";

export type QuarterTurn = 0 | 1 | 2 | 3;
export const nextRotation = (rotation: QuarterTurn) => ((rotation + 1) % 4) as QuarterTurn;
export const rotatedSeatIndex = (index: number, rotation: QuarterTurn) => (index + rotation) % 4;
export const rotatedShogiViewer = (side: Side, rotation: QuarterTurn): Side =>
  shogiSides[(shogiSides.indexOf(side) + 4 - rotation) % 4];

/** Convert a displayed square back to the unchanged game/replay coordinates. */
export function boardPositionForDisplay(
  position: { x: number; y: number },
  size: number,
  rotation: QuarterTurn,
) {
  const { x, y } = position;
  const last = size - 1;
  switch (rotation) {
    case 0:
      return { x, y };
    case 1:
      return { x: y, y: last - x };
    case 2:
      return { x: last - x, y: last - y };
    case 3:
      return { x: last - y, y: x };
  }
}
