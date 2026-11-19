import type { RoomIndexRetentionStatus } from "../adapters/room/indexJob";

const retentionMs = 30 * 24 * 60 * 60 * 1000;
const batchSize = 25;
const unknownClosure = -1;
// 時刻不明の行も同じ索引で巡回します。実際の削除条件では NULL を期限切れにしません。
const closedSortAt = "coalesce(closed_at_ms, closed_observed_at_ms, -1)";
const matchingClosedRow = "room_id=? AND instance_id IS ? AND revision=? AND closed=1";

type Cursor = { closed_sort_at_ms: number; room_id: string };
type Candidate = Cursor & { instance_id: string | null; revision: number };
const start: Cursor = { closed_sort_at_ms: unknownClosure, room_id: "" };

type RetentionOptions = { deleteExpired: boolean; inspectCandidates: boolean };

export const roomIndexRetentionCandidatesSql = `
  SELECT room_id, instance_id, revision, ${closedSortAt} AS closed_sort_at_ms
  FROM room_index INDEXED BY room_index_closed_retention
  WHERE closed=1 AND ${closedSortAt} BETWEEN ? AND ?
    AND (${closedSortAt}, room_id) > (?, ?)
  ORDER BY ${closedSortAt}, room_id
  LIMIT ?
`;

export async function runRoomIndexRetention(
  env: Pick<Env, "APP_DB" | "GAME_ROOM">,
  options: RetentionOptions,
  now = Date.now,
) {
  const db = env.APP_DB;
  const cutoff = now() - retentionMs;
  const stats = {
    ...(await countCandidates(db, cutoff)),
    checked: 0,
    observed: 0,
    deleted: 0,
    changed: 0,
    failures: 0,
    rpcResults: {} as Partial<Record<RoomIndexRetentionStatus, number>>,
  };
  if (!options.deleteExpired && !options.inspectCandidates) return stats;

  const cursor =
    (await db
      .prepare("SELECT closed_sort_at_ms, room_id FROM room_index_retention_cursor WHERE id=1")
      .first<Cursor>()) ?? start;
  const { results: rows } = await db
    .prepare(roomIndexRetentionCandidatesSql)
    .bind(cursor.closed_sort_at_ms, cutoff, cursor.closed_sort_at_ms, cursor.room_id, batchSize)
    .all<Candidate>();
  for (const row of rows) {
    stats.checked++;
    try {
      const status = await env.GAME_ROOM.getByName(row.room_id).checkRoomIndexRetention(
        row.revision,
      );
      stats.rpcResults[status] = (stats.rpcResults[status] ?? 0) + 1;
      if (status !== "ready" || !options.deleteExpired) continue;
      if (row.closed_sort_at_ms === unknownClosure) {
        if (await observeClosure(db, row, now())) stats.observed++;
        else stats.changed++;
      } else if (await deleteClosedIndex(db, row, cutoff)) stats.deleted++;
      else stats.changed++;
    } catch {
      stats.failures++;
    }
  }

  await saveCursor(db, cursor, rows.length === batchSize ? rows[batchSize - 1] : start);
  return stats;
}

async function countCandidates(db: D1Database, cutoff: number) {
  const {
    results: [counts],
  } = await db
    .prepare(`
      SELECT COUNT(*) AS total, COUNT(CASE WHEN ${closedSortAt} = -1 THEN 1 END) AS unknown_closure
      FROM room_index INDEXED BY room_index_closed_retention
      WHERE closed=1 AND ${closedSortAt} <= ?
    `)
    .bind(cutoff)
    .all<{ total: number; unknown_closure: number }>();
  return { expired: counts.total - counts.unknown_closure, unknownClosure: counts.unknown_closure };
}

async function saveCursor(db: D1Database, cursor: Cursor, next: Cursor): Promise<void> {
  // 保留と失敗も通過させ、後続を詰まらせず毎時の処理で次の一巡を行います。
  await db
    .prepare(`
    INSERT INTO room_index_retention_cursor (id, closed_sort_at_ms, room_id) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      closed_sort_at_ms=excluded.closed_sort_at_ms, room_id=excluded.room_id
    WHERE room_index_retention_cursor.closed_sort_at_ms=?
      AND room_index_retention_cursor.room_id=?
  `)
    .bind(next.closed_sort_at_ms, next.room_id, cursor.closed_sort_at_ms, cursor.room_id)
    .run();
}

async function observeClosure(
  db: D1Database,
  row: Candidate,
  observedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
    UPDATE room_index SET closed_observed_at_ms=?
    WHERE ${matchingClosedRow} AND closed_at_ms IS NULL AND closed_observed_at_ms IS NULL
  `)
    .bind(observedAt, row.room_id, row.instance_id, row.revision)
    .run();
  return result.meta.changes > 0;
}

async function deleteClosedIndex(db: D1Database, row: Candidate, cutoff: number): Promise<boolean> {
  const eligible = `${matchingClosedRow} AND coalesce(closed_at_ms, closed_observed_at_ms) <= ?`;
  const values = [row.room_id, row.instance_id, row.revision, cutoff] as const;
  const [, deleted] = await db.batch([
    db
      .prepare(`
      INSERT INTO room_index_deleted_revisions (room_id, deleted_through_revision)
      SELECT room_id, revision FROM room_index WHERE ${eligible}
      ON CONFLICT (room_id) DO UPDATE SET deleted_through_revision =
        max(room_index_deleted_revisions.deleted_through_revision, excluded.deleted_through_revision)
    `)
      .bind(...values),
    db.prepare(`DELETE FROM room_index WHERE ${eligible}`).bind(...values),
  ]);
  return deleted.meta.changes > 0;
}
