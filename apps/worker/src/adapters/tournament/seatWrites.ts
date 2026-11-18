import { seatReferenceStatements } from "../room/seatReservations";
import { prepareSeatMergedAbort, seatFence } from "../../flows/accountSeats/fences";
import type { Player, WaitingProfile } from "@tetraboard/context-tournament";
export function prepareTournamentPlayer(
  db: D1Database,
  player: Player,
  profile: WaitingProfile,
  key: string,
) {
  const a = player.admission;
  const candidate = {
    sql: `FROM user u JOIN tournament_wait_reservations w ON w.account_id=u.id
      JOIN tournament_entries e ON e.account_id=u.id AND e.tournament_key=w.tournament_key AND e.deleted=0
      WHERE u.id=? AND w.operation_id=? AND w.tournament_key=? AND w.match_operation_id=? AND u.profileCompleted=1 AND u.name=? AND u.avatarKey IS ? AND u.avatarPresetId IS ?`,
    values: [
      a.accountId,
      player.operationId,
      key,
      a.operationId,
      profile.name,
      profile.avatarKey,
      profile.avatarPresetId,
    ],
  };
  const fence = seatFence("u.id", a.operationId);
  return [
    db
      .prepare(
        "UPDATE tournament_wait_reservations SET match_operation_id=? WHERE account_id=? AND operation_id=?",
      )
      .bind(a.operationId, a.accountId, player.operationId),
    db
      .prepare(`INSERT INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,avatar_preset_id,created_at_ms)
        SELECT u.id,?,?,?,?,u.name,?,?,? ${candidate.sql} AND ${fence.sql}
        ON CONFLICT(account_id) DO NOTHING`)
      .bind(
        a.operationId,
        a.roomId,
        a.instanceId,
        a.playerId,
        a.avatarKey,
        a.avatarPresetId ?? null,
        Date.now(),
        ...candidate.values,
        ...fence.values,
      ),
    prepareSeatMergedAbort(db, "u.id", a.operationId, candidate),
    ...seatReferenceStatements(db, a.operationId),
  ].map((value) => ({ value }));
}
