import type { MatchKind, RoomPublicMetadata } from "@tetraboard/protocol";
import { retiredName } from "@tetraboard/context-privacy";
import { roomHostAccountExistsSql, roomParticipantScrubSql } from "./indexScrub";
import { indexedParticipantsSchema, type IndexedRoomParticipant } from "./roomIndexParticipants";

export type PendingRoomIndex = {
  revision: number;
  closed: boolean;
  closedAtMs?: number;
  metadata: RoomPublicMetadata & {
    matchKind?: MatchKind;
    matchSequence?: number;
    instanceId?: string;
    hostPlayerId?: string | null;
    participantPreviews?: IndexedRoomParticipant[];
  };
  retryAtMs: number;
};

export async function writeRoomIndex(db: D1Database, pending: PendingRoomIndex): Promise<void> {
  const room = pending.metadata;
  // ホストは直接の退会だけを照合し、参加者はゲストの統合先も照合します。
  const retiredHost = roomHostAccountExistsSql(
    "incoming.room_id",
    "incoming.instance_id",
    "incoming.host_player_id",
    "r.account_id IN (SELECT id FROM deleted_accounts)",
  );
  const participants = roomParticipantScrubSql(
    "scrub_input.room_id",
    "scrub_input.instance_id",
    "scrub_input.participants_json",
  );
  await db
    .prepare(roomIndexUpsertSql(retiredHost, participants))
    .bind(
      room.id,
      room.game,
      room.mode ?? "standard",
      room.timeControl.mainTimeMs,
      room.timeControl.byoyomiMs,
      room.status,
      room.hostName,
      room.hostAvatarUrl ?? null,
      room.humanCount,
      room.cpuCount,
      room.capacity,
      room.openSeats,
      room.updatedAtMs,
      pending.revision,
      pending.closed ? 1 : 0,
      room.instanceId ?? null,
      room.hostPlayerId ?? null,
      room.tournamentId ?? null,
      room.matchmaking ? 1 : 0,
      room.participantPreviews === undefined
        ? null
        : JSON.stringify(indexedParticipantsSchema.parse(room.participantPreviews)),
      room.matchKind ?? null,
      room.matchSequence ?? null,
      pending.closed ? (pending.closedAtMs ?? null) : null,
      retiredName,
    )
    .run();
}

function roomIndexUpsertSql(
  retiredHost: string,
  participants: ReturnType<typeof roomParticipantScrubSql>,
) {
  return `WITH incoming (
        room_id, game, mode, main_time_ms, byoyomi_ms, status, host_name, host_avatar_url,
        human_count, cpu_count, capacity, open_seats, updated_at_ms, revision, closed,
        instance_id, host_player_id, tournament_id, matchmaking, participants_json, match_kind, match_sequence,
        closed_at_ms
      ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)),
      scrub_input AS MATERIALIZED (
        SELECT incoming.*, ${retiredHost} AS retired_host FROM incoming
      )
      INSERT INTO room_index (
        room_id, game, mode, main_time_ms, byoyomi_ms, status, host_name, host_avatar_url,
        human_count, cpu_count, capacity, open_seats, updated_at_ms, revision, closed,
        instance_id, host_player_id, tournament_id, matchmaking, participants_json, match_kind, match_sequence,
        closed_at_ms
      )
      SELECT room_id, game, mode, main_time_ms, byoyomi_ms, status,
        CASE WHEN retired_host THEN ? ELSE host_name END,
        CASE WHEN retired_host THEN NULL ELSE host_avatar_url END,
        human_count, cpu_count, capacity, open_seats, updated_at_ms, revision, closed, instance_id,
        CASE WHEN retired_host THEN NULL ELSE host_player_id END,
        tournament_id, matchmaking,
        CASE WHEN ${participants.needed} THEN ${participants.scrubbed} ELSE participants_json END,
        match_kind, match_sequence, closed_at_ms
      FROM scrub_input
      WHERE NOT EXISTS (
        SELECT 1 FROM room_index_deleted_revisions AS deleted
        WHERE deleted.room_id = scrub_input.room_id
          AND deleted.deleted_through_revision >= scrub_input.revision
      )
      ON CONFLICT(room_id) DO UPDATE SET
        game = excluded.game,
        mode = excluded.mode,
        main_time_ms = excluded.main_time_ms,
        byoyomi_ms = excluded.byoyomi_ms,
        status = excluded.status,
        host_name = excluded.host_name,
        host_avatar_url = excluded.host_avatar_url,
        human_count = excluded.human_count,
        cpu_count = excluded.cpu_count,
        capacity = excluded.capacity,
        open_seats = excluded.open_seats,
        updated_at_ms = excluded.updated_at_ms,
        revision = excluded.revision,
        closed = excluded.closed,
        instance_id = excluded.instance_id,
        host_player_id = excluded.host_player_id,
        tournament_id = excluded.tournament_id,
        matchmaking = excluded.matchmaking,
        participants_json = excluded.participants_json,
        match_kind = excluded.match_kind,
        match_sequence = excluded.match_sequence,
        closed_at_ms = excluded.closed_at_ms,
        closed_observed_at_ms = NULL
      WHERE excluded.revision > room_index.revision`;
}
