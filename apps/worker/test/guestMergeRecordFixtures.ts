import { applyD1Migrations, env } from "cloudflare:test";
import { accountFixture } from "./accountFixtures";

const bindings = env as typeof env & {
  GUEST_MERGES_TEST_DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
export const guestMergeDb = bindings.GUEST_MERGES_TEST_DB;
export const testMigrations = bindings.TEST_MIGRATIONS;

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
