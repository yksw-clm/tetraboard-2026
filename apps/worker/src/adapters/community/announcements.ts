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
const columns = `a.id, a.title, a.body, a.published_on AS date, a.kind, a.published, a.created_at_ms, a.updated_at_ms, a.version,
 (SELECT json_group_array(game) FROM announcement_lobby_targets WHERE announcement_id = a.id) AS lobby_games`;
const order = "a.published_on DESC, a.created_at_ms DESC, a.id DESC";
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

function publishAnnouncementEvent(db: D1Database, id: string) {
  return db
    .prepare(`INSERT OR IGNORE INTO notification_events(kind,source_id,account_id,created_at_ms)
 SELECT 'announcement',a.id,'',a.updated_at_ms FROM announcements a
 WHERE changes()=1 AND a.id=? AND a.published=1
 AND NOT EXISTS(SELECT 1 FROM notification_events WHERE kind='announcement' AND source_id=a.id AND account_id='')`)
    .bind(id);
}

export async function create(db: D1Database, input: AnnouncementInput) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO announcements (id, title, body, published_on, kind, published, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, input.title, input.body, input.date, input.kind, Number(input.published), now, now),
    publishAnnouncementEvent(db, id),
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
  // 掲載先と記事は更新前の番号でガードし、通知は直前の記事更新が成功した場合にだけ追加します。
  const articleUpdateIndex = input.lobbyGames.length + 1;
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
        "UPDATE announcements SET title = ?, body = ?, published_on = ?, kind = ?, published = ?, updated_at_ms = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING id",
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
    publishAnnouncementEvent(db, id),
  ]);
  return result[articleUpdateIndex]!.results.length === 1;
}

export function announcementStore(db: D1Database): AnnouncementQueries<Row> & AnnouncementWrites {
  return {
    record,
    position: (row) => ({ date: row.date, at: row.created_at_ms, id: row.id }),
    read: (id, publishedOnly) => read(db, id, publishedOnly),
    async list(publishedOnly, after, take) {
      const conditions = [publishedOnly ? "a.published = 1" : "1 = 1"];
      // 日付の上限も指定して、カーソルの位置から索引を読み始めます。
      if (after)
        conditions.push(
          "a.published_on <= ? AND (a.published_on, a.created_at_ms, a.id) < (?, ?, ?)",
        );
      const rows = await db
        .prepare(
          `SELECT ${columns} FROM announcements a WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ?`,
        )
        .bind(...(after ? [after.date, after.date, after.at, after.id] : []), take)
        .all<Row>();
      return rows.results;
    },
    latestPublishedForLobby: (game) =>
      db
        .prepare(
          `SELECT ${columns} FROM announcements a WHERE a.published = 1 AND EXISTS (SELECT 1 FROM announcement_lobby_targets WHERE announcement_id = a.id AND game = ?) ORDER BY ${order} LIMIT 1`,
        )
        .bind(game)
        .first<Row>(),
    create: (input) => create(db, input),
    update: (id, input, version) => update(db, id, input, version),
  };
}
