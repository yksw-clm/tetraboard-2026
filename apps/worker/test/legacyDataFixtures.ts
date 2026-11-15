import { env } from "cloudflare:workers";
import type { applyD1Migrations } from "cloudflare:test";

export async function normalizeLegacyData(db: D1Database) {
  const migrations = (
    env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }
  ).TEST_MIGRATIONS;
  const migration = migrations.find((entry) => entry.name.startsWith("0046_"));
  if (!migration) throw new Error("Missing legacy data migration");
  await db.batch(migration.queries.map((query) => db.prepare(query)));
}

export async function migratedShogiArchiveJson(db: D1Database, json: string) {
  const record: { id: string; startedAtMs: number; endedAtMs: number; settings: { mode: string } } =
    JSON.parse(json);
  await db
    .prepare("INSERT INTO matches VALUES(?,'four-shogi',?,?,?,?)")
    .bind(record.id, record.settings.mode, record.startedAtMs, record.endedAtMs, json)
    .run();
  await normalizeLegacyData(db);
  const migrated = await db
    .prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(record.id)
    .first<string>("record_json");
  await db.prepare("DELETE FROM matches WHERE id=?").bind(record.id).run();
  if (!migrated) throw new Error("Missing migrated archive");
  return migrated;
}
