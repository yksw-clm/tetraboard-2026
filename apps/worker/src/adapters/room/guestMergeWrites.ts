export function guestSeatTransferStatement(
  db: D1Database,
  guestId: string,
  targetId: string,
  held: { room_id: string; instance_id: string; player_id: string | null },
) {
  return db
    .prepare(`UPDATE account_room_seats SET account_id=?
    WHERE account_id=? AND room_id=? AND instance_id=? AND player_id=?`)
    .bind(targetId, guestId, held.room_id, held.instance_id, held.player_id);
}
