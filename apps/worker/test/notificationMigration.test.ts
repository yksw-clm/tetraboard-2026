import { applyD1Migrations, env } from "cloudflare:test";
import { expect, test } from "vitest";

test("0061 は既存の通知・既読・削除済み番号を含む採番上限を引き継ぐ", async () => {
  const { NOTIFICATION_MIGRATION_TEST_DB: db, TEST_MIGRATIONS: migrations } = env as typeof env & {
    NOTIFICATION_MIGRATION_TEST_DB: D1Database;
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  };
  const cutoff = migrations.findIndex(({ name }) => name.startsWith("0061_"));
  expect(migrations[cutoff - 1]?.name).toBe("0060_board_reports.sql");
  await applyD1Migrations(db, migrations.slice(0, cutoff));

  await db.batch([
    db.prepare(`INSERT INTO notification_events(seq,kind,source_id,account_id,created_at_ms,payload_json,legacy)
      VALUES(100,'announcement','article','',1,'{}',1),
            (101,'tournament','result','reader',2,'{"rank":1}',0),
            (102,'badge','match','reader',3,'{"badges":[]}',0),
            (150,'badge','deleted-match','reader',4,'{}',0)`),
    db.prepare(
      "INSERT INTO account_notification_reads VALUES ('reader',100),('reader',101),('other',100)",
    ),
    db.prepare("INSERT INTO account_notification_state VALUES ('reader',100,150),('other',100,0)"),
    db.prepare("DELETE FROM notification_events WHERE seq=150"),
  ]);
  const snapshot = async () => {
    const results = await db.batch([
      db.prepare("SELECT * FROM notification_events ORDER BY seq"),
      db.prepare("SELECT * FROM account_notification_reads ORDER BY account_id,notification_seq"),
      db.prepare("SELECT * FROM account_notification_state ORDER BY account_id"),
    ]);
    return results.map(({ results }) => results);
  };
  const issuedThrough = () =>
    db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name='notification_events'")
      .first<number>("seq");
  const before = await snapshot();
  const oldSequence = await issuedThrough();
  expect(oldSequence).toBe(150);
  expect(await db.prepare("SELECT MAX(seq) AS max FROM notification_events").first("max")).toBe(
    102,
  );

  await applyD1Migrations(db, [migrations[cutoff]!]);

  expect(await snapshot()).toEqual(before);
  expect(await issuedThrough()).toBe(oldSequence);
  const next = await db
    .prepare(`INSERT INTO notification_events(kind,source_id,account_id,created_at_ms)
      VALUES('reply','new-reply','reader',5) RETURNING seq`)
    .first<number>("seq");
  expect(next).toBeGreaterThan(oldSequence!);

  await db.prepare("DELETE FROM notification_events WHERE seq=101").run();
  expect((await snapshot())[1]).toEqual([
    { account_id: "other", notification_seq: 100 },
    { account_id: "reader", notification_seq: 100 },
  ]);
});
