export type DueRoomDeadline =
  | { type: "timeout"; at: number }
  | { type: "disconnect"; at: number; playerId: string };

/** 同時刻は時計を優先し、切断同士は入力のプレイヤー配列順を保つ。 */
export function nextDueRoomDeadline(
  clockDeadline: number | null,
  players: readonly {
    id: string;
    reconnectDeadline: number | null;
    registrationPendingUntilMs?: number;
  }[],
  now: number,
): DueRoomDeadline | null {
  let next: DueRoomDeadline | null =
    clockDeadline !== null && clockDeadline <= now ? { type: "timeout", at: clockDeadline } : null;
  for (const player of players) {
    if ((player.registrationPendingUntilMs ?? 0) > now) continue;
    const at = player.reconnectDeadline;
    if (at !== null && at <= now && (next === null || at < next.at))
      next = { type: "disconnect", at, playerId: player.id };
  }
  return next;
}
