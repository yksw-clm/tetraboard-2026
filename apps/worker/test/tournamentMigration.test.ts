import { env, applyD1Migrations } from "cloudflare:test";
import { expect, test } from "vitest";
import { accountFixture } from "./accountFixtures";
import { record, readTournament, updateDraft } from "../src/tournaments/store";
import { legacyTournamentSettings } from "@tetraboard/protocol";

test("大会設定の移行は既存大会・参照・確定得点を保持し、旧下書きだけを保存時に版2へ移す", async () => {
  const bindings = env as unknown as {
    TOURNAMENT_MIGRATION_TEST_DB: D1Database;
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  };
  const db = bindings.TOURNAMENT_MIGRATION_TEST_DB;
  const migrations = bindings.TEST_MIGRATIONS;
  await applyD1Migrations(
    db,
    migrations.filter((m) => m.name < "0030"),
  );
  const account = await accountFixture(true, crypto.randomUUID(), db);
  const key = crypto.randomUUID(),
    draftKey = crypto.randomUUID(),
    entryId = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,finalized_at_ms,created_at_ms,updated_at_ms,chat_accepting) VALUES(?,1,'旧大会',1,2,1,3,?, ?,0)",
      )
      .bind(key, now, now),
    db
      .prepare(
        "INSERT INTO tournaments(key,name,created_at_ms,updated_at_ms) VALUES(?,'旧下書き',?,?)",
      )
      .bind(draftKey, now, now),
    db
      .prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)")
      .bind(entryId, key, account.id, now),
    db
      .prepare(
        "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,first,rank_sum,final_rank) VALUES(?,?,48,1,1,1,1)",
      )
      .bind(entryId, key),
  ]);
  const before = await db.prepare("SELECT * FROM tournament_scores").all();
  await applyD1Migrations(db, migrations);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect((await db.prepare("SELECT * FROM tournament_scores").all()).results).toEqual(
    before.results,
  );
  const old = (await readTournament(db, key))!;
  expect(old).toMatchObject({
    public_id: 1,
    rule_version: 1,
    chat_accepting: 0,
    finalized_at_ms: 3,
  });
  expect((await record(db, old)).settings).toEqual(legacyTournamentSettings);
  const settings = {
    game: "four-gomoku" as const,
    mode: "singles" as const,
    timeControl: { mainTimeMs: 60000 as const, byoyomiMs: 10000 as const },
  };
  expect(
    await updateDraft(
      db,
      draftKey,
      {
        name: "新下書き",
        description: "",
        rulesDescription: "",
        startsAtMs: null,
        endsAtMs: null,
        settings,
      },
      1,
    ),
  ).toBe(true);
  expect(await record(db, (await readTournament(db, draftKey))!)).toMatchObject({
    ruleVersion: 2,
    settings,
  });
  expect((await readTournament(db, key))!.rule_version).toBe(1);
});
