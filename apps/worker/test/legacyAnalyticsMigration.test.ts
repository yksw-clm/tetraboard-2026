import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, test } from "vitest";
import { accountFixture } from "./accountFixtures";

test("旧分析のテーブルと参照だけを削除し、業務スキーマ・データ・月次KPIを保持する", async () => {
  const bindings = env as typeof env & {
    ANALYTICS_FOUNDATION_TEST_DB: D1Database;
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  };
  const db = bindings.ANALYTICS_FOUNDATION_TEST_DB;
  const migrations = bindings.TEST_MIGRATIONS;
  await applyD1Migrations(
    db,
    migrations.filter((m) => m.name < "0045"),
  );
  const account = await accountFixture(true, crypto.randomUUID(), db);
  await db.batch([
    db.prepare("INSERT INTO kpi_monthly VALUES('2026-10','registrations',7,1)"),
    db.prepare("INSERT INTO matches VALUES('match','four-reversi','singles',1,2,'{}')"),
    db
      .prepare(
        "INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game) VALUES(?,'match','singles',1,'four-reversi')",
      )
      .bind(account.id),
    db
      .prepare("INSERT INTO four_reversi_rating_changes VALUES('match',?,25,8,26,7,1,1)")
      .bind(account.id),
    db.prepare(
      "INSERT INTO analytics_pageviews(id,visitor_id,page,started_at_ms) VALUES('view','visitor','general-lobby',1)",
    ),
    db.prepare("INSERT INTO analytics_dwell VALUES('view','1970-01-01',1)"),
    db.prepare(
      "INSERT INTO analytics_matches(id,game,mode,started_at_ms,status,cpu_count) VALUES('match','four-reversi','singles',1,'completed',0)",
    ),
    db
      .prepare(
        "INSERT INTO analytics_participants(match_id,player_id,account_id) VALUES('match','player',?)",
      )
      .bind(account.id),
    db.prepare(
      "INSERT INTO analytics_registration_flows(id,created_at_ms,kind,entry,game) VALUES('flow',1,'guest','login-page','all')",
    ),
    db.prepare("INSERT INTO analytics_registration_events VALUES('flow','entry',1)"),
    db.prepare("INSERT INTO analytics_registration_attempts VALUES('state','flow','google',1,2)"),
    db.prepare(
      "INSERT INTO analytics_sessions(id,visitor_id,started_at_ms,last_activity_ms) VALUES('session','visitor',1,2)",
    ),
    db.prepare("INSERT INTO analytics_session_visits VALUES('session','all',1,NULL,0)"),
    db
      .prepare("INSERT INTO account_game_daily VALUES(?,'1970-01-01','four-reversi',1)")
      .bind(account.id),
    db.prepare("INSERT INTO account_usage VALUES(?,1,'1970-01-01')").bind(account.id),
    db.prepare("INSERT INTO account_game_totals VALUES(?,'four-reversi',1,1,2)").bind(account.id),
  ]);
  const schema = () =>
    db
      .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
      .all<{ type: string; name: string; tbl_name: string; sql: string | null }>();
  const retired =
    /analytics_|account_game_daily|account_usage|account_game_totals|account_totals_dirty/;
  const before = (await schema()).results;
  expect(
    before.filter((row) => row.type === "table" && row.name.startsWith("analytics_")),
  ).toHaveLength(28);
  expect(
    before.filter(
      (row) => row.type === "trigger" && !retired.test(row.tbl_name) && retired.test(row.sql ?? ""),
    ),
  ).toHaveLength(20);
  const businessSchema = before.filter(
    (row) => !retired.test(row.name) && !retired.test(row.sql ?? ""),
  );
  const businessTables = businessSchema.filter(
    (row) =>
      row.type === "table" &&
      !row.name.startsWith("sqlite_") &&
      !row.name.startsWith("_cf_") &&
      row.name !== "d1_migrations",
  );
  const rows = () =>
    Promise.all(
      businessTables.map(async ({ name }) => ({
        name,
        rows: (await db.prepare(`SELECT * FROM "${name}"`).all()).results,
      })),
    );
  const data = await rows();

  await applyD1Migrations(db, migrations);
  expect(
    (
      await db
        .prepare(`SELECT type,name FROM sqlite_master WHERE name LIKE '%analytics_%' OR sql LIKE '%analytics_%'
    OR name IN ('account_game_daily','account_usage','account_game_totals','account_totals_dirty')
    OR sql LIKE '%account_game_daily%' OR sql LIKE '%account_usage%' OR sql LIKE '%account_game_totals%' OR sql LIKE '%account_totals_dirty%'`)
        .all()
    ).results,
  ).toEqual([]);
  expect((await schema()).results).toEqual(businessSchema);
  expect(await rows()).toEqual(data);
  expect(
    await db
      .prepare("SELECT value FROM kpi_monthly WHERE month='2026-10' AND metric='registrations'")
      .first("value"),
  ).toBe(7);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
