export type { Position, Side } from "@tetraboard/four-shogi";
export type { ShogiAction as FourShogiAction, HandPieceKind, PieceKind } from "@tetraboard/shogi";
import type { Piece as StandardPiece, HandPieceKind } from "@tetraboard/shogi";
import type { Side } from "@tetraboard/four-shogi";
export type Piece = Omit<StandardPiece, "side"> & { side: Side };
export type Board = readonly (readonly (Piece | null)[])[];
export type Hand = Readonly<Partial<Record<HandPieceKind, number>>>;
export type Hands = Readonly<Partial<Record<Side, Hand>>>;
