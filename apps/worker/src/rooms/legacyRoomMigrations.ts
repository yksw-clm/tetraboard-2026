import {
  roundReplaySchema,
  type FourShogiRoom,
  type FourReversiRoom,
  type FourGomokuRoom,
  type FourGomokuReplay,
} from "@tetraboard/protocol";
import { getActionAvailability } from "@tetraboard/four-shogi";
import type { Color, Position } from "@tetraboard/four-gomoku";

export function migrateLegacyFourShogiRoom(room: FourShogiRoom, saved: object): void {
  if (room.status === "playing" && !Object.hasOwn(saved, "threePlayerAttackForbiddenActions"))
    Object.assign(room, getActionAvailability({ ...room.game, repetitions: {} }));
}
export function migrateLegacyFourReversiRoom(
  room: FourReversiRoom,
  saved: object,
  readReplay: () => unknown,
): void {
  if (room.status !== "playing" || Object.hasOwn(saved, "eliminations")) return;
  const replay = readReplay();
  if (replay === undefined) return;
  for (const { action } of roundReplaySchema.parse(replay).steps)
    if (
      action.type === "eliminate" &&
      room.game.eliminatedColors.includes(action.color) &&
      !room.eliminations.some((e) => e.color === action.color)
    )
      room.eliminations.push({ color: action.color, reason: action.reason });
}
export function migrateLegacyFourGomokuRoom(room: FourGomokuRoom, readReplay: () => unknown): void {
  if (room.status !== "playing" || room.game.lastMoves) return;
  // 旧局面には表示用の履歴がないため、永続棋譜の確定着手から復元します。
  const replay = readReplay() as FourGomokuReplay | undefined;
  if (!replay || replay.id !== room.roundId) return;
  const lastMoves: Partial<Record<Color, Position>> = {};
  for (const { action } of replay.steps)
    if (action.type === "place") lastMoves[action.color] = action.position;
  room.game.lastMoves = lastMoves;
}
