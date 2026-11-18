import type { AnnouncementQueries, AnnouncementWrites } from "@tetraboard/context-community";
import {
  announcementRecordSchema,
  type AnnouncementInput,
  type AnnouncementRecord,
} from "@tetraboard/protocol";

type Row = {
  id: string;
  title: string;
  body: string;
  date: string;
  kind: string;
  published: number;
  created_at_ms: number;
  updated_at_ms: number;
  version: number;
  lobby_games: string;
};
const columns = `a.*, (SELECT json_group_array(game) FROM announcement_lobby_targets WHERE announcement_id = a.id) AS lobby_games`;
function record(row: Row): AnnouncementRecord {
  return announcementRecordSchema.parse({
    id: row.id,
    title: row.title,
    body: row.body,
    date: row.date,
    kind: row.kind,
    published: Boolean(row.published),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    version: row.version,
    lobbyGames: JSON.parse(row.lobby_games),
  });
}
const read = (db: D1Database, id: string, publicOnly = false) =>
  db
    .prepare(
      `SELECT ${columns} FROM announcements a WHERE a.id = ? ${publicOnly ? "AND a.published = 1" : ""}`,
    )
    .bind(id)
    .first<Row>();
export async function create(db: D1Database, input: AnnouncementInput) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO announcements (id, title, body, date, kind, published, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, input.title, input.body, input.date, input.kind, Number(input.published), now, now),
    ...input.lobbyGames.map((game) =>
      db
        .prepare("INSERT INTO announcement_lobby_targets (announcement_id, game) VALUES (?, ?)")
        .bind(id, game),
    ),
  ]);
  return id;
}
export async function update(
  db: D1Database,
  id: string,
  input: AnnouncementInput,
  version: number,
) {
  // batch内の各変更を同じ更新番号でガードし、最後に番号を進めます。競合時は掲載先も変更しません。
  const result = await db.batch([
    db
      .prepare(
        "DELETE FROM announcement_lobby_targets WHERE announcement_id = ? AND EXISTS (SELECT 1 FROM announcements WHERE id = ? AND version = ?)",
      )
      .bind(id, id, version),
    ...input.lobbyGames.map((game) =>
      db
        .prepare(
          "INSERT INTO announcement_lobby_targets (announcement_id, game) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM announcements WHERE id = ? AND version = ?)",
        )
        .bind(id, game, id, version),
    ),
    db
      .prepare(
        "UPDATE announcements SET title = ?, body = ?, date = ?, kind = ?, published = ?, updated_at_ms = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING id",
      )
      .bind(
        input.title,
        input.body,
        input.date,
        input.kind,
        Number(input.published),
        Date.now(),
        id,
        version,
      ),
  ]);
  return result.at(-1)!.results.length === 1;
}

export function announcementStore(db: D1Database): AnnouncementQueries<Row> & AnnouncementWrites {
  return {
    record,
    position: (row) => ({ date: row.date, at: row.created_at_ms, id: row.id }),
    read: (id, publishedOnly) => read(db, id, publishedOnly),
    async list(publishedOnly, after, take) {
      const conditions = [publishedOnly ? "a.published = 1" : "1 = 1"];
      if (after) conditions.push("(a.date, a.created_at_ms, a.id) < (?, ?, ?)");
      const rows = await db
        .prepare(
          `SELECT ${columns} FROM announcements a WHERE ${conditions.join(" AND ")} ORDER BY a.date DESC, a.created_at_ms DESC, a.id DESC LIMIT ?`,
        )
        .bind(...(after ? [after.date, after.at, after.id] : []), take)
        .all<Row>();
      return rows.results;
    },
    latestPublishedForLobby: (game) =>
      db
        .prepare(
          `SELECT ${columns} FROM announcements a WHERE a.published = 1 AND EXISTS (SELECT 1 FROM announcement_lobby_targets WHERE announcement_id = a.id AND game = ?) ORDER BY a.date DESC, a.created_at_ms DESC, a.id DESC LIMIT 1`,
        )
        .bind(game)
        .first<Row>(),
    create: (input) => create(db, input),
    update: (id, input, version) => update(db, id, input, version),
  };
}
