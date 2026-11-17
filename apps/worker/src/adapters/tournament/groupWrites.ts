import type { State, Group } from "@tetraboard/context-tournament";
export async function ensureTournamentGroup(db: D1Database, state: State, group: Group) {
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO tournament_matches(id,tournament_key,room_id,instance_id,phase,updated_at_ms) VALUES(?,?,?,?,'reserved',?)",
      )
      .bind(group.id, state.key, group.roomId, group.instanceId, Date.now()),
    ...group.players.flatMap((p) => [
      db
        .prepare(
          "INSERT OR IGNORE INTO tournament_match_players(match_id,entry_id,account_id,player_id,operation_id) VALUES(?,?,?,?,?)",
        )
        .bind(group.id, p.entryId, p.accountId, p.admission.playerId, p.admission.operationId),
      db
        .prepare(
          "UPDATE tournament_wait_reservations SET lease_until_ms=? WHERE account_id=? AND operation_id=?",
        )
        .bind(p.expiresAtMs, p.accountId, p.operationId),
    ]),
  ]);
}
