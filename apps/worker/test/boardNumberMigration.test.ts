import { applyD1Migrations, env } from "cloudflare:test";
import { expect, test } from "vitest";
import { D1BoardReader } from "../src/adapters/community/boardReads";
import { readBoardModeration } from "../src/adapters/community/boardModeration";
import { readNotifications } from "../src/adapters/community/notifications";
import { accountFixture } from "./accountFixtures";

test("0062 は既存の親投稿を安定順で採番し、返信・いいね・通報・通知を維持する", async () => {
  const { BOARD_NUMBER_MIGRATION_TEST_DB: db, TEST_MIGRATIONS: migrations } = env as typeof env & {
    BOARD_NUMBER_MIGRATION_TEST_DB: D1Database;
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  };
  const cutoff = migrations.findIndex(({ name }) => name === "0062_board_post_numbers.sql");
  expect(migrations[cutoff - 1]?.name).toBe("0061_board_reply_notifications.sql");
  await applyD1Migrations(db, migrations.slice(0, cutoff));

  const author = await accountFixture(true, undefined, db);
  const reader = await accountFixture(true, undefined, db);
  const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
  const insert = (n: number, time: number, parentId: string | null = null) =>
    db
      .prepare(`INSERT INTO board_posts(id,game_id,parent_id,account_id,body,posted_at_ms,request_id,body_hash)
      VALUES(?,'reversi',?,?,'本文',?,?,'hash')`)
      .bind(id(n), parentId, parentId === null ? author.id : reader.id, time, id(n));
  await db.batch([
    insert(3, 10),
    insert(2, 10),
    insert(1, 20),
    insert(4, 30, id(2)),
    db.prepare("UPDATE board_posts SET body=NULL,deleted_at_ms=40 WHERE id=?").bind(id(1)),
    db.prepare("INSERT INTO board_likes VALUES (?,?,?)").bind(id(2), reader.id, 31),
    db
      .prepare(`INSERT INTO board_reports(id,post_id,game_id,parent_id,author_name,body,posted_at_ms,reason,reported_at_ms)
      VALUES('report',?,'reversi',?,'返信者','返信の証拠',30,'abuse',32)`)
      .bind(id(4), id(2)),
    db
      .prepare(`INSERT INTO notification_events(seq,kind,source_id,account_id,created_at_ms)
      VALUES (100,'reply',?,?,30)`)
      .bind(id(4), author.id),
    db.prepare("INSERT INTO account_notification_reads VALUES (?,100)").bind(author.id),
  ]);
  const snapshot = async () =>
    (
      await db.batch([
        db.prepare("SELECT * FROM board_posts ORDER BY id"),
        db.prepare("SELECT * FROM board_likes"),
        db.prepare("SELECT * FROM board_reports"),
        db.prepare("SELECT * FROM notification_events ORDER BY seq"),
        db.prepare("SELECT * FROM account_notification_reads"),
      ])
    ).map(({ results }) => results);
  const before = await snapshot();

  await applyD1Migrations(db, migrations.slice(cutoff, cutoff + 1));

  expect(await snapshot()).toEqual(before);
  const numbers = async () =>
    (await db.prepare("SELECT number,post_id FROM board_post_numbers ORDER BY number").all())
      .results;
  const migrated = [
    { number: 1, post_id: id(2) },
    { number: 2, post_id: id(3) },
    { number: 3, post_id: id(1) },
  ];
  expect(await numbers()).toEqual(migrated);
  const board = new D1BoardReader(db);
  expect(await board.detail(1, reader.id, false)).toMatchObject({
    post: { id: id(2), publicNumber: 1, likeCount: 1, liked: true },
    replies: [{ id: id(4), own: true }],
  });
  expect(await board.detail(3, null, false)).toBeNull();
  expect(await readNotifications(db, author.id, { id: 100, includeReplies: true })).toMatchObject([
    { id: 100, read: true, reply: { postId: id(2), postNumber: 1, replyId: id(4) } },
  ]);
  expect(await readBoardModeration(db, 32)).toMatchObject({
    reports: [{ id: "report", postId: id(4), parentId: id(2), postNumber: 1 }],
  });

  await expect(
    db.batch([
      db
        .prepare("UPDATE sqlite_sequence SET seq=? WHERE name='board_post_numbers'")
        .bind(Number.MAX_SAFE_INTEGER),
      insert(5, 50),
    ]),
  ).rejects.toThrow("board_post_numbers_safe_integer");
  expect(await numbers()).toEqual(migrated);
  expect(await snapshot()).toEqual(before);
  await insert(5, 50).run();
  expect(await numbers()).toEqual([...migrated, { number: 4, post_id: id(5) }]);
  await db.prepare("DELETE FROM board_posts WHERE id=?").bind(id(5)).run();
  await insert(6, 60).run();
  expect(await numbers()).toEqual([...migrated, { number: 5, post_id: id(6) }]);
});
