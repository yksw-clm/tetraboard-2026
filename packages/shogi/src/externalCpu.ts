import type { ExternalCpuDefinition } from "@tetraboard/game-contract";
import type { ShogiTypes } from "./definition";
import { positionKey } from "./repetition";
import type { HandPieceKind, ShogiAction } from "./types";

const usiPieces = {
  rook: "R",
  bishop: "B",
  gold: "G",
  silver: "S",
  knight: "N",
  lance: "L",
  pawn: "P",
} as const;

export function usiMove(action: ShogiAction): string {
  const square = ({ x, y }: { x: number; y: number }) => `${9 - x}${"abcdefghi"[y]}`;
  return action.type === "movePiece"
    ? `${square(action.from)}${square(action.to)}${action.promote ? "+" : ""}`
    : `${usiPieces[action.pieceKind]}*${square(action.to)}`;
}

export const shogiExternalCpu: ExternalCpuDefinition<ShogiTypes> = {
  getPositionKey: (state) =>
    JSON.stringify([
      positionKey(state),
      state.moveNumber,
      state.nonChecks,
      state.drawProposals,
      state.result,
    ]),
  createRequest: (_state, _seat, _level, options) => createShogiAiRequest(options),
  readMove: (move) => {
    const square = (file: string, rank: string) => ({
      x: 9 - Number(file),
      y: "abcdefghi".indexOf(rank),
    });
    if (/^[1-9][a-i][1-9][a-i]\+?$/.test(move))
      return {
        type: "movePiece",
        from: square(move[0], move[1]),
        to: square(move[2], move[3]),
        promote: move.endsWith("+"),
      };
    if (!/^[RBGSNLP]\*[1-9][a-i]$/.test(move)) return null;
    const pieceKind = (Object.keys(usiPieces) as HandPieceKind[]).find(
      (kind) => usiPieces[kind] === move[0],
    )!;
    return { type: "dropPiece", pieceKind, to: square(move[2], move[3]) };
  },
};

export function createShogiAiRequest(options: ShogiTypes["externalOptions"]) {
  return {
    nodes: options.nodes ?? 256,
    moves: options.moves,
    ...(options.standardBook && options.moves.length < 2 ? { opening_book: "standard-v1" } : {}),
  };
}
