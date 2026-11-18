import { acceptedDeletionSql, type DeletionBatch } from "../../db/deletionGuard";
import { roomHostAccountExistsSql, roomParticipantScrubSql } from "./indexScrub";

export function hideDeletedRoomPlayersStatements(
  db: D1Database,
  { accountId, batchReceipt }: DeletionBatch,
  retiredName: string,
) {
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
      .prepare(`UPDATE room_index SET host_name=?3,host_avatar_url=NULL,host_player_id=NULL
      WHERE ${acceptedDeletionSql} AND ${retiredHost}`)
      .bind(accountId, batchReceipt, retiredName),
    db
      .prepare(`UPDATE room_index SET participants_json=${participants.scrubbed}
      WHERE ${acceptedDeletionSql} AND ${participants.needed}`)
      .bind(accountId, batchReceipt),
  ];
}
