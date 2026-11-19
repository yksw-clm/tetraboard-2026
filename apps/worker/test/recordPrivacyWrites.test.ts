import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { guestReplayTransferStatements } from "../src/adapters/record/guestMergeWrites";
import { D1MatchRecordStore } from "../src/adapters/record/matchRecordStore";
import { scrubRetiredMatchClaimStatements } from "../src/adapters/record/privacyScrub";
import { markDeleted } from "./guestFenceFixtures";
import { seedMerge, storedRecord, testMigrations } from "./guestMergeRecordFixtures";

const { RECORD_PRIVACY_TEST_DB } = env as typeof env & { RECORD_PRIVACY_TEST_DB: D1Database };
const scrubTriggers = [
  "privacy_scrub_matches_insert",
  "privacy_scrub_matches_update",
  "privacy_scrub_claimed_match_insert",
  "privacy_scrub_claimed_match_update",
  "privacy_scrub_shogi_match_uploads_insert",
  "privacy_scrub_shogi_match_uploads_update",
  "privacy_scrub_claimed_upload_insert",
  "privacy_scrub_claimed_upload_update",
  "privacy_scrub_retired_match_claim",
];
const retired = { accountId: null, name: "退会したプレイヤー", retired: true };

beforeAll(async () => {
  await applyD1Migrations(RECORD_PRIVACY_TEST_DB, testMigrations);
  await RECORD_PRIVACY_TEST_DB.batch(
    scrubTriggers.map((name) => RECORD_PRIVACY_TEST_DB.prepare(`DROP TRIGGER ${name}`)),
  );
});

function recordFixture() {
  const guest = crypto.randomUUID();
  const target = crypto.randomUUID();
  const other = crypto.randomUUID();
  const record = {
    id: crypto.randomUUID(),
    settings: { game: "shogi" },
    startedAtMs: 1,
    endedAtMs: 2,
    replay: { eventCount: 0 },
    participants: [
      { id: "merged", kind: "human", accountId: guest, name: "統合前", seat: 0 },
      { id: "other", kind: "human", accountId: other, name: "相手", seat: 1 },
      { id: "guest", kind: "human", accountId: null, name: "ゲスト", seat: 2 },
      { id: "cpu", kind: "cpu", level: 2, name: "CPU", seat: 3 },
    ],
    result: { order: ["other", "merged", "guest", "cpu"] },
  };
  return { guest, target, other, record };
}

async function seedRetiredClaim(db: D1Database, matchId: string, playerId: string) {
  await db
    .prepare(`INSERT INTO match_participant_accounts
      (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
      VALUES(?,?,NULL,'room','instance','retired',0,0)`)
    .bind(matchId, playerId)
    .run();
}

describe.each([
  { label: "トリガーあり", db: env.APP_DB },
  { label: "トリガーなし", db: RECORD_PRIVACY_TEST_DB },
])("$label", ({ db }) => {
  const store = new D1MatchRecordStore(db);

  test.each([
    { name: "退会なし", deleted: null, retiredSeat: null },
    { name: "統合先が退会済み", deleted: "target", retiredSeat: null },
    { name: "別の参加者が退会済み", deleted: "other", retiredSeat: null },
    { name: "統合した席の引き継ぎが失効", deleted: null, retiredSeat: "merged" },
    { name: "別の席の引き継ぎが失効", deleted: null, retiredSeat: "other" },
    { name: "統合先が退会済みで別の席の引き継ぎも失効", deleted: "target", retiredSeat: "other" },
  ])("$name の保存・再送・保存待ちの更新", async ({ deleted, retiredSeat }) => {
    const { guest, target, other, record } = recordFixture();
    await seedMerge(db, guest, target);
    if (deleted) await markDeleted(db, deleted === "target" ? target : other);
    if (retiredSeat) await seedRetiredClaim(db, record.id, retiredSeat);
    const mergedParticipants = record.participants.map((p) =>
      p.id === "merged" ? { ...p, accountId: target } : p,
    );
    const participants = mergedParticipants.map((p) =>
      p.id === retiredSeat ||
      (deleted === "target" && p.accountId === target) ||
      (deleted === "other" && p.accountId === other)
        ? { ...p, ...retired }
        : p,
    );
    const json = JSON.stringify(record, null, 2);
    const expected = JSON.stringify({ ...record, participants });

    await store.insertUpload(record, json, 0);
    expect(await store.readUpload(record.id)).toBe(expected);
    await store.publication(record.id).run();
    await store.insertUpload(record, json.replace('"endedAtMs": 2', '"endedAtMs": 3'), 0);
    await store.publication(record.id).run();
    expect(await store.readUpload(record.id)).toBe(expected);
    expect(await storedRecord(db, "matches", record.id)).toBe(expected);

    const updated = { ...record, endedAtMs: 3, participants: mergedParticipants };
    const updatedJson = JSON.stringify(updated);
    expect(await store.replaceUpload(record.id, expected, updatedJson)).toBe(updatedJson);
    expect(await store.readUpload(record.id)).toBe(JSON.stringify({ ...updated, participants }));
    expect(await store.replaceUpload(record.id, expected, json)).toBeNull();
    expect(await storedRecord(db, "matches", record.id)).toBe(expected);
  });

  test("保存待ちの作成後に統合先が退会した場合も公開時に伏せ字にする", async () => {
    const { guest, target, record } = recordFixture();
    const json = JSON.stringify(record, null, 2);
    await store.insertUpload(record, json, 0);
    await seedMerge(db, guest, target);
    await markDeleted(db, target);

    expect(await store.readUpload(record.id)).toBe(json);
    await store.publication(record.id).run();
    const [first, ...others] = record.participants;
    expect(await storedRecord(db, "matches", record.id)).toBe(
      JSON.stringify({ ...record, participants: [{ ...first, ...retired }, ...others] }),
    );
  });

  test("統合による公開済み・保存待ちの更新は退会済みアカウントを復元しない", async () => {
    const { guest, target, record } = recordFixture();
    const json = JSON.stringify(record, null, 2);
    await store.insertUpload(record, json, 0);
    await store.publication(record.id).run();
    await markDeleted(db, target);
    await seedRetiredClaim(db, record.id, "other");

    await db.batch(guestReplayTransferStatements(db, guest, target));
    const [first, other, ...others] = record.participants;
    const expected = JSON.stringify({
      ...record,
      participants: [{ ...first, ...retired }, { ...other, ...retired }, ...others],
    });
    expect(await store.readUpload(record.id)).toBe(expected);
    expect(await storedRecord(db, "matches", record.id)).toBe(expected);
  });

  test("引き継ぎを retired にした batch で公開済み・保存待ちの同じ席を伏せ字にする", async () => {
    const { target, record } = recordFixture();
    const json = JSON.stringify(record, null, 2);
    const playerId = "guest";
    await store.insertUpload(record, json, 0);
    await store.publication(record.id).run();
    await db
      .prepare(`INSERT INTO match_participant_accounts
        (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
        VALUES(?,?,?,'room','instance','applied',0,0)`)
      .bind(record.id, playerId, target)
      .run();
    const scrub = () => scrubRetiredMatchClaimStatements(db, record.id, playerId);
    await db.batch(scrub());
    expect(await store.readUpload(record.id)).toBe(json);
    expect(await storedRecord(db, "matches", record.id)).toBe(json);

    await db.batch([
      db
        .prepare(`UPDATE match_participant_accounts SET state='retired', account_id=NULL
        WHERE match_id=? AND player_id=? AND account_id=?`)
        .bind(record.id, playerId, target),
      ...scrub(),
    ]);
    const expected = JSON.stringify({
      ...record,
      participants: record.participants.map((p) => (p.id === playerId ? { ...p, ...retired } : p)),
    });
    expect(await store.readUpload(record.id)).toBe(expected);
    expect(await storedRecord(db, "matches", record.id)).toBe(expected);
  });
});
