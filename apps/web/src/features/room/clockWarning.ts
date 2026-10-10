import type { Room } from "@tetraboard/protocol";

export const clockWarningMs = 5_000;

export interface ClockCount {
  id: string;
  playerId: string | null;
  expiresAt: number;
}

export function roomClockCount(room: Room): ClockCount | null {
  if (room.status !== "playing") return null;
  const player = room.players.find(
    (player) => ("color" in player ? player.color : player.side) === room.game.turn,
  );
  const eliminated =
    "eliminatedColors" in room.game
      ? room.game.eliminatedColors.some((seat) => seat === room.game.turn)
      : room.game.eliminations.some((entry) => entry.side === room.game.turn);
  return {
    id: JSON.stringify([
      room.instanceId,
      "roundId" in room ? room.roundId : null,
      room.clock.turnStartedAt,
      room.game.moveNumber,
      room.game.turn,
    ]),
    playerId: !eliminated && player?.kind === "human" ? player.id : null,
    expiresAt: room.clock.turnExpiresAt,
  };
}

/** 復旧時の基準と通知済み記録を分け、時刻補正で同じカウントを再演しません。 */
export class ClockWarningTracker {
  private readonly handled = new Set<string>();

  consume(count: ClockCount | null): void {
    if (count === null) return;
    this.handled.add(count.id);
    if (this.handled.size > 64) this.handled.delete(this.handled.values().next().value!);
  }

  baseline(count: ClockCount | null, nowMs: number): void {
    if (count !== null && count.expiresAt - nowMs <= clockWarningMs) this.consume(count);
  }

  observe(count: ClockCount | null, nowMs: number, playerId: string | null): number | null {
    if (count === null) return null;
    const remaining = count.expiresAt - nowMs;
    if (remaining > clockWarningMs || this.handled.has(count.id)) return null;
    this.consume(count);
    return remaining > 0 && playerId !== null && count.playerId === playerId ? remaining : null;
  }
}
