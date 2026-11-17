import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { accountFixture } from "./accountFixtures";

const bindings = env as typeof env & {
  GUEST_MERGES_TEST_DB: D1Database;
  GUEST_MERGES_WITHOUT_TRIGGERS_TEST_DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
export const withTriggers = bindings.GUEST_MERGES_TEST_DB;
export const withoutTriggers = bindings.GUEST_MERGES_WITHOUT_TRIGGERS_TEST_DB;
export const databases = [withTriggers, withoutTriggers];
export const mergeTriggers = [
  "guest_merged_match_insert",
  "guest_merged_upload_insert",
  "guest_merged_history_insert",
];
beforeAll(async () => {
  for (const db of databases) await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  for (const name of mergeTriggers) await withoutTriggers.exec(`DROP TRIGGER ${name}`);
});

export async function seedMerge(db: D1Database, guest: string, account: string) {
  await accountFixture(true, guest, db);
  await accountFixture(true, account, db);
  await db.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest).run();
  const token = crypto.randomUUID();
  const state = crypto.randomUUID();
  await db
    .prepare("INSERT INTO guest_sessions(token_hash,account_id,expires_at_ms) VALUES(?,?,?)")
    .bind(token, guest, 2000)
    .run();
  await db
    .prepare(`INSERT INTO guest_oauth_flows
      (state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,target_id,target_session_id)
      SELECT ?,?,?,'google',0,2000,?,id FROM session WHERE userId=?`)
    .bind(state, guest, token, account, account)
    .run();
  await db.prepare("INSERT INTO guest_account_merges VALUES(?,?,1000)").bind(guest, account).run();
}

export async function storedRecord(db: D1Database, table: string, id: string) {
  return db
    .prepare(`SELECT record_json FROM ${table} WHERE id=?`)
    .bind(id)
    .first<string>("record_json");
}

export async function history(db: D1Database, id: string) {
  return (
    await db
      .prepare("SELECT * FROM account_match_history WHERE match_id=? ORDER BY account_id")
      .bind(id)
      .all()
  ).results;
}

export async function clearRecord(db: D1Database, id: string) {
  for (const table of ["account_match_history", "match_event_chunks", "match_uploads", "matches"])
    await db
      .prepare(
        `DELETE FROM ${table} WHERE ${table === "matches" || table === "match_uploads" ? "id" : "match_id"}=?`,
      )
      .bind(id)
      .run();
}

// 変更前のINSERTを残し、同じトリガー付きDBで保存結果を比較します。
export function legacyPublication(db: D1Database, id: string) {
  return db
    .prepare(`INSERT INTO matches (id,game,mode,started_at_ms,ended_at_ms,record_json)
    SELECT id,json_extract(record_json,'$.settings.game'),COALESCE(json_extract(record_json,'$.settings.mode'),'standard'),
      json_extract(record_json,'$.startedAtMs'),json_extract(record_json,'$.endedAtMs'),record_json
    FROM match_uploads u WHERE id=?
      AND (SELECT COUNT(*) FROM match_event_chunks WHERE match_id=u.id)=u.chunk_count
      AND COALESCE((SELECT SUM(event_count) FROM match_event_chunks WHERE match_id=u.id),0)=u.event_count
    ON CONFLICT(id) DO NOTHING`)
    .bind(id);
}

export function legacyHistory(db: D1Database, id: string) {
  return db
    .prepare(`INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game)
    SELECT json_extract(p.value,'$.accountId'),m.id,m.mode,m.started_at_ms,m.game
    FROM matches m,json_each(m.record_json,'$.participants') p WHERE m.id=?
      AND json_extract(p.value,'$.kind')='human' AND json_extract(p.value,'$.accountId') IS NOT NULL
    ON CONFLICT(account_id,match_id) DO NOTHING`)
    .bind(id);
}
