import { deletionGuard, type DeletionScope } from "../../db/deletionGuard";
import { roomHostAccountExistsSql, roomParticipantScrubSql } from "./indexScrub";

export function hideDeletedRoomPlayersStatements(
  db: D1Database,
  deletion: DeletionScope,
  retiredName: string,
) {
  const guard = deletionGuard(deletion);
  const retiredHost = roomHostAccountExistsSql(
    "room_index.room_id",
    "room_index.instance_id",
    "room_index.host_player_id",
    "r.account_id=?1",
  );
  const participants = roomParticipantScrubSql(
    "room_index.room_id",
    "room_index.instance_id",
    "room_index.participants_json",
  );
  return [
    db
      .prepare(`UPDATE room_index SET host_name=?2,host_avatar_url=NULL,host_player_id=NULL
      WHERE ${retiredHost} AND ${guard.sql}`)
      .bind(...guard.params(retiredName)),
    db
      .prepare(`UPDATE room_index SET participants_json=${participants.scrubbed}
      WHERE ${participants.needed} AND ${guard.sql}`)
      .bind(...guard.params()),
  ];
}
