import type { FourGomokuRoom, GomokuRoom, ReversiRoom, ShogiRoom } from "@tetraboard/protocol";
import type { Color as ReversiColor } from "@tetraboard/reversi";
import type { FourReversiRoom, FourShogiRoom } from "@tetraboard/protocol";
import type { Color } from "@tetraboard/four-reversi";
import type { Side } from "@tetraboard/four-shogi";
import { clockPresentation } from "./roomClockPresentation";
export function playerClock(
  room: FourReversiRoom | FourGomokuRoom,
  color: Color | null,
  serverNowMs: number,
) {
  if (room.status === "playing" && color !== null) {
    if (
      room.game.eliminatedColors.includes(color) ||
      ("completedColors" in room.game && room.game.completedColors.includes(color))
    )
      return null;
    return clockPresentation({
      timeControl: room.settings.timeControl,
      remainingMainMs: room.clock.remainingMainMs[color],
      turnStartedAt: room.clock.turnStartedAt,
      turnExpiresAt: room.clock.turnExpiresAt,
      isTurn: room.game.turn === color,
      serverNowMs,
    });
  }
  return clockPresentation({ timeControl: room.settings.timeControl, serverNowMs });
}

export function shogiPlayerClock(
  room: FourShogiRoom | ShogiRoom,
  side: Side | null,
  serverNowMs: number,
) {
  if (room.status === "playing" && side !== null) {
    if (room.game.eliminations.some((entry) => entry.side === side)) return null;
    return clockPresentation({
      timeControl: room.settings.timeControl,
      remainingMainMs: (room.clock.remainingMainMs as Partial<Record<Side, number>>)[side] ?? 0,
      turnStartedAt: room.clock.turnStartedAt,
      turnExpiresAt: room.clock.turnExpiresAt,
      isTurn: room.game.turn === side,
      serverNowMs,
    });
  }
  return clockPresentation({ timeControl: room.settings.timeControl, serverNowMs });
}

export function reversiPlayerClock(
  room: ReversiRoom | GomokuRoom,
  color: ReversiColor | null,
  serverNowMs: number,
) {
  if (room.status === "playing" && color !== null)
    return clockPresentation({
      timeControl: room.settings.timeControl,
      remainingMainMs: room.clock.remainingMainMs[color],
      turnStartedAt: room.clock.turnStartedAt,
      turnExpiresAt: room.clock.turnExpiresAt,
      isTurn: room.game.turn === color,
      serverNowMs,
    });
  return clockPresentation({ timeControl: room.settings.timeControl, serverNowMs });
}
