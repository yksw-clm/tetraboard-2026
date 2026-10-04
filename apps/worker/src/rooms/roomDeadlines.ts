export type DueRoomDeadline =
  | { type: "timeout"; at: number }
  | { type: "disconnect"; at: number; playerId: string };

/** 同時刻は時計を優先し、切断同士は入力のプレイヤー配列順を保つ。 */
export function nextDueRoomDeadline(
  clockDeadline: number | null,
  players: readonly { id: string; reconnectDeadline: number | null }[],
  now: number,
): DueRoomDeadline | null {
  let next: DueRoomDeadline | null =
    clockDeadline !== null && clockDeadline <= now ? { type: "timeout", at: clockDeadline } : null;
  for (const player of players) {
    const at = player.reconnectDeadline;
    if (at !== null && at <= now && (next === null || at < next.at))
      next = { type: "disconnect", at, playerId: player.id };
  }
  return next;
}

/** 過去の候補も補正せず返す。候補収集・Alarm I/Oは呼び出し側が担当する。 */
export function earliestAlarmAt(candidates: readonly number[]): number | null {
  return candidates.length === 0 ? null : Math.min(...candidates);
}
