import { seatReferenceStatements } from "../room/seatReservations";
import { prepareSeatMergedAbort, seatFence } from "../../flows/accountSeats/fences";
import type { Player, Group, MatchmakingWrite } from "@tetraboard/context-matchmaking";
import type { ratedMatchmakingPolicy } from "./ratedMatchmaking";
export function preparePlayerWrites(
  db: D1Database,
  policy: ReturnType<typeof ratedMatchmakingPolicy> | undefined,
  player: Player,
  group: Group,
  now: number,
): MatchmakingWrite[] {
  const statements: D1PreparedStatement[] = [];
  const a = player.admission;
  const candidate = {
    sql: `FROM user u JOIN matchmaking_wait_reservations w ON w.account_id=u.id WHERE u.id=? AND w.operation_id=? AND w.match_operation_id=? AND u.profileCompleted=1 AND u.name=? AND u.avatarKey IS ? AND u.avatarPresetId IS ?`,
    values: [
      a.accountId,
      player.operationId,
      a.operationId,
      a.name,
      a.avatarKey,
      a.avatarPresetId ?? null,
    ],
  };
  const fence = seatFence("u.id", a.operationId);
  statements.push(
    db
      .prepare(
        "UPDATE matchmaking_wait_reservations SET match_operation_id=? WHERE account_id=? AND operation_id=?",
      )
      .bind(a.operationId, a.accountId, player.operationId),
    db
      .prepare(`INSERT OR IGNORE INTO account_room_seats(account_id,operation_id,room_id,instance_id,player_id,name,avatar_key,avatar_preset_id,created_at_ms)
      SELECT u.id,?,?,?,?,u.name,?,?,? ${candidate.sql} AND ${fence.sql}`)
      .bind(
        a.operationId,
        a.roomId,
        a.instanceId,
        a.playerId,
        a.avatarKey,
        a.avatarPresetId ?? null,
        now,
        ...candidate.values,
        ...fence.values,
      ),
    prepareSeatMergedAbort(db, "u.id", a.operationId, candidate),
    ...seatReferenceStatements(db, a.operationId),
  );
  if (group.rating && policy)
    statements.push(policy.store.reserve(db, group.id, a.accountId, a.operationId));
  return statements.map((value) => ({ value }));
}
