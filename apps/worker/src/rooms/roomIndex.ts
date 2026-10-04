import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { roomPublicMetadataSchema, type RoomPublicMetadata } from "@tetraboard/protocol";

export type PendingRoomIndex = {
  revision: number;
  closed: boolean;
  metadata: RoomPublicMetadata;
  retryAtMs: number;
};

type IndexRow = {
  room_id: string;
  game: string;
  mode: string;
  main_time_ms: number;
  byoyomi_ms: number;
  status: string;
  host_name: string | null;
  host_avatar_url: string | null;
  human_count: number;
  cpu_count: number;
  capacity: number;
  open_seats: number;
  updated_at_ms: number;
};

export async function writeRoomIndex(db: D1Database, pending: PendingRoomIndex): Promise<void> {
  const room = pending.metadata;
  await db
    .prepare(
      `INSERT INTO room_index (
        room_id, game, mode, main_time_ms, byoyomi_ms, status, host_name, host_avatar_url,
        human_count, cpu_count, capacity, open_seats, updated_at_ms, revision, closed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        closed = excluded.closed
      WHERE excluded.revision > room_index.revision`,
    )
    .bind(
      room.id,
      room.game,
      room.mode,
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
    )
    .run();
}

function parseRow(row: IndexRow): RoomPublicMetadata {
  return roomPublicMetadataSchema.parse({
    id: row.room_id,
    game: row.game,
    mode: row.mode,
    timeControl: { mainTimeMs: row.main_time_ms, byoyomiMs: row.byoyomi_ms },
    status: row.status,
    hostName: row.host_name,
    hostAvatarUrl: row.host_avatar_url,
    humanCount: row.human_count,
    cpuCount: row.cpu_count,
    capacity: row.capacity,
    openSeats: row.open_seats,
    updatedAtMs: row.updated_at_ms,
  });
}

export async function listRoomIndex(
  db: D1Database,
  cursor: { updatedAtMs: number; id: string } | null,
  game: GameId = defaultGameId,
): Promise<{ rooms: RoomPublicMetadata[]; nextCursor: string | null }> {
  const query = `SELECT room_id, game, mode, main_time_ms, byoyomi_ms, status,
      host_name, host_avatar_url, human_count, cpu_count, capacity, open_seats, updated_at_ms
    FROM room_index
    WHERE closed = 0 AND status IN ('waiting', 'playing') AND game = ?`;
  const statement = cursor
    ? db
        .prepare(
          `${query} AND (updated_at_ms < ? OR (updated_at_ms = ? AND room_id < ?))
           ORDER BY updated_at_ms DESC, room_id DESC LIMIT 21`,
        )
        .bind(game, cursor.updatedAtMs, cursor.updatedAtMs, cursor.id)
    : db.prepare(`${query} ORDER BY updated_at_ms DESC, room_id DESC LIMIT 21`).bind(game);
  const result = await statement.all<IndexRow>();
  const rooms = result.results.slice(0, 20).map(parseRow);
  const last = rooms.at(-1);
  return {
    rooms,
    nextCursor: result.results.length > 20 && last ? `${last.updatedAtMs}:${last.id}` : null,
  };
}
