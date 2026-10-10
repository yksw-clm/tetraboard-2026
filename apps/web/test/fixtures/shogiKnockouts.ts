import {
  applyAction,
  eliminateSide,
  type FourShogiState,
  type Piece,
  type Side,
} from "@tetraboard/four-shogi";
import type { FourShogiReplayEvent } from "@tetraboard/protocol";
import { initialShogiState } from "./fourShogiFixtures";
import { createFourShogiReplayFrame } from "../../src/features/room/fourShogiReplay";

export function simultaneousMateFrames(
  mode: "singles" | "doubles" = "singles",
  discovered = false,
) {
  const state = initialShogiState();
  const board: (Piece | null)[][] = Array.from({ length: 9 }, () =>
    Array<Piece | null>(9).fill(null),
  );
  const pieces: { side: Side; kind: Piece["kind"]; x: number; y: number }[] = [
    { side: "south", kind: "king", x: 4, y: 8 },
    { side: "west", kind: "king", x: 0, y: 0 },
    { side: mode === "doubles" ? "east" : "north", kind: "king", x: 8, y: 0 },
    { side: mode === "doubles" ? "north" : "east", kind: "king", x: 8, y: 8 },
    { side: "south", kind: "rook", x: 4, y: 1 },
    { side: "south", kind: "gold", x: 1, y: 2 },
    { side: "south", kind: "gold", x: 7, y: 2 },
    ...(discovered
      ? [
          { side: "west" as const, kind: "rook" as const, x: 6, y: 0 },
          { side: "south" as const, kind: "gold" as const, x: 5, y: 0 },
        ]
      : []),
  ];
  pieces.forEach((piece, index) => {
    board[piece.y]![piece.x] = {
      id: index + 1,
      side: piece.side,
      kind: piece.kind,
      promoted: false,
    };
  });
  const initial: FourShogiState = {
    ...state,
    mode,
    board,
    nextPieceId: pieces.length + 1,
    repetitions: {},
    threePlayerAttackProhibited: false,
  };
  const event: FourShogiReplayEvent = {
    type: "action",
    side: "south",
    action: { type: "movePiece", from: { x: 4, y: 1 }, to: { x: 4, y: 0 }, promote: false },
  };
  const result = applyAction(initial, event.side, event.action);
  if (!result.ok) throw new Error("Invalid mate fixture");
  const frames = [
    createFourShogiReplayFrame(initial),
    createFourShogiReplayFrame(result.state, { before: initial, event }),
  ];
  if (result.state.status === "playing") {
    const left = { type: "eliminate", side: "east", reason: "left" } as const;
    const final = eliminateSide(result.state, left.side, left.reason);
    if (!final.ok) throw new Error("Invalid final departure");
    frames.push(createFourShogiReplayFrame(final.state, { before: result.state, event: left }));
  }
  return frames;
}
