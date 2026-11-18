import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, test, vi } from "vitest";
import { digest } from "../src/crypto";
import { feedbackAccountHash } from "../src/flows/accountPurge/feedbackAccountHash";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { accountFixture } from "./accountFixtures";
import { testMigrations } from "./guestMergeRecordFixtures";

const bindings = env as typeof env & {
  DELETION_CASCADE_TEST_DB: D1Database;
  DELETION_WITH_TRIGGERS_TEST_DB: D1Database;
};
const withoutTriggers = bindings.DELETION_CASCADE_TEST_DB;
const withTriggers = bindings.DELETION_WITH_TRIGGERS_TEST_DB;
const movedTriggers = [
  "privacy_hide_feedback",
  "privacy_hide_room_index",
  "privacy_hide_room_participants",
  "privacy_pending_images",
  "privacy_retire_match_claims",
  "privacy_scrub_existing",
  "privacy_scrub_retired_match_claim",
  "privacy_scrub_matches_update",
  "privacy_scrub_claimed_match_update",
  "privacy_scrub_shogi_match_uploads_update",
  "privacy_scrub_claimed_upload_update",
  "privacy_scrub_room_index_update",
  "privacy_scrub_room_participants_update",
];

beforeAll(async () => {
  await Promise.all(
    [withoutTriggers, withTriggers].map((db) => applyD1Migrations(db, testMigrations)),
  );
  await withoutTriggers.batch(
    movedTriggers.map((name) => withoutTriggers.prepare(`DROP TRIGGER ${name}`)),
  );
});

const owner = "deletion-owner";
const other = "deletion-opponent";
const guest = "deletion-merged-guest";
const receipt = "deletion-receipt";
const retiredName = "退会したプレイヤー";
const host = { playerId: "host", appearance: { kind: "human", avatarUrl: "/host" } };
const merged = { playerId: "merged", appearance: { kind: "human", avatarUrl: "/merged" } };
const visitor = { playerId: "visitor", appearance: { kind: "human", avatarUrl: "/visitor" } };
const cpu = { playerId: "cpu", appearance: { kind: "cpu", level: 2 } };
const participants = [host, merged, visitor, cpu];
const departing = { id: "primary", name: "本人の保存名", accountId: owner };
const claimed = { id: "claimed", name: "登録前の名前", accountId: null };
const opponent = { id: "visitor", name: "相手の保存名", accountId: other };
const playerCases = {
  direct: [departing, opponent],
  claim: [claimed, opponent],
  unrelated: [opponent],
};

function feedback(db: D1Database, id: string, accountId: string | null, hash: string) {
  return db
    .prepare(`INSERT INTO feedback(id, submission_id, payload_hash, author, reporter_hash,
    internal, kind, game, body, expectation, steps, received_at_ms, expires_at_ms, account_id)
    VALUES (?,?,'hash','author',?,0,'bug','reversi','body','','',1,2,?)`)
    .bind(id, id, hash, accountId);
}

function room(db: D1Database, id: string, instance: string, playerId: string) {
  return db
    .prepare(`INSERT INTO room_index (room_id, game, mode, main_time_ms, byoyomi_ms, status,
    host_name, human_count, cpu_count, capacity, open_seats, updated_at_ms, revision, instance_id,
    host_player_id, host_avatar_url, participants_json)
    VALUES (?,'four-reversi','singles',300000,0,'waiting','ホスト名',3,1,4,0,1,7,?,?,'/host',?)`)
    .bind(id, instance, playerId, JSON.stringify(participants));
}

function recordStatements(db: D1Database) {
  return Object.entries(playerCases).flatMap(([id, players]) => {
    const json = JSON.stringify({
      participants: players,
      result: { order: players.map((p) => p.id) },
    });
    return [
      db
        .prepare(
          "INSERT INTO matches (id, game, mode, started_at_ms, ended_at_ms, record_json) VALUES (?,'shogi','standard',1,2,?)",
        )
        .bind(id, json),
      db.prepare("INSERT INTO match_uploads VALUES (?,?,0,0)").bind(id, json),
    ];
  });
}

async function seed(db: D1Database) {
  await accountFixture(true, owner, db);
  await accountFixture(true, other, db);
  await db.batch([
    db
      .prepare("UPDATE user SET avatarKey='avatars/profile.webp',image='/profile' WHERE id=?")
      .bind(owner),
    feedback(db, "direct", owner, "old-hash"),
    feedback(db, "hashed", null, await feedbackAccountHash(env, owner)),
    feedback(db, "other", other, "other-hash"),
    db
      .prepare(
        "INSERT INTO guest_account_merges (guest_id, account_id, merged_at_ms) VALUES (?,?,1)",
      )
      .bind(guest, owner),
    room(db, "host-room", "instance", host.playerId),
    room(db, "other-room", "new-instance", visitor.playerId),
    db
      .prepare(
        "INSERT INTO privacy_room_players VALUES (?,'host-room','instance',?,'avatars/seat.webp')",
      )
      .bind(owner, host.playerId),
    db
      .prepare("INSERT INTO privacy_room_players VALUES (?,'host-room','instance',?,NULL)")
      .bind(guest, merged.playerId),
    db
      .prepare("INSERT INTO privacy_room_players VALUES (?,'other-room','old-instance',?,NULL)")
      .bind(owner, visitor.playerId),
    db
      .prepare(
        "INSERT INTO privacy_avatar_uploads VALUES ('avatars/upload.webp',?,1),('avatars/other.webp',?,1)",
      )
      .bind(owner, other),
    ...recordStatements(db),
    db
      .prepare(`INSERT INTO match_participant_accounts
      (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
      VALUES ('claim','claimed',?,'host-room','instance','applied',1,0),
        ('pending','claimed',?,'host-room','instance','pending',1,0),
        ('claim','visitor',?,'host-room','instance','applied',1,0)`)
      .bind(owner, owner, other),
    db
      .prepare(
        "INSERT INTO account_match_history (account_id,match_id,mode,started_at_ms,game) VALUES (?,'direct','standard',1,'shogi'),(?,'direct','standard',1,'shogi')",
      )
      .bind(owner, other),
  ]);
}

const stateQueries = {
  feedback: "SELECT id,deleted FROM feedback ORDER BY id",
  rooms:
    "SELECT room_id,host_name,host_avatar_url,host_player_id,participants_json,revision FROM room_index ORDER BY room_id",
  images: "SELECT account_id,key FROM deletion_images ORDER BY key",
  queuedRooms: "SELECT room_id FROM deletion_rooms ORDER BY room_id",
  claims:
    "SELECT match_id,player_id,account_id,state FROM match_participant_accounts ORDER BY match_id,player_id",
  matches: "SELECT id,record_json FROM matches ORDER BY id",
  uploads: "SELECT id,record_json FROM match_uploads ORDER BY id",
  history: "SELECT account_id,match_id FROM account_match_history ORDER BY account_id",
  sessions: "SELECT userId FROM session ORDER BY userId",
  profiles:
    "SELECT id,name,username,avatarKey,image,publicProfileId IS NOT NULL AS has_public_id,profileCompleted FROM user ORDER BY id",
  receipt: "SELECT id,receipt_hash,avatar_key FROM deleted_accounts",
};

type StateKey = keyof typeof stateQueries;
async function state(db: D1Database) {
  const entries = Object.entries(stateQueries);
  const result = await db.batch(entries.map(([, sql]) => db.prepare(sql)));
  return Object.fromEntries(
    entries.map(([name], index) => [name, result[index].results]),
  ) as Record<StateKey, Record<string, unknown>[]>;
}

function expectRetiredRecords(rows: Awaited<ReturnType<typeof state>>["matches"]) {
  expect(rows.map(({ id, record_json }) => [id, JSON.parse(String(record_json))])).toEqual(
    Object.entries(playerCases)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, players]) => [
        id,
        {
          participants: players.map((p) =>
            p === departing || p === claimed
              ? { ...p, accountId: null, name: retiredName, retired: true }
              : p,
          ),
          result: { order: players.map((p) => p.id) },
        },
      ]),
  );
}

test("退会受付の batch でトリガーの有無によらず同じ情報を削除・伏せ字にする", async () => {
  await Promise.all([withoutTriggers, withTriggers].map(seed));

  for (const db of [withTriggers, withoutTriggers])
    expect(await requestDeletion({ ...env, APP_DB: db }, owner, receipt)).toBe(true);

  const actual = await state(withoutTriggers);
  expect(actual).toEqual(await state(withTriggers));
  expect(actual.feedback).toEqual([
    { id: "direct", deleted: 1 },
    { id: "hashed", deleted: 1 },
    { id: "other", deleted: 0 },
  ]);
  expect(actual.rooms).toEqual([
    {
      room_id: "host-room",
      host_name: retiredName,
      host_player_id: null,
      host_avatar_url: null,
      participants_json: JSON.stringify([
        { ...host, appearance: { kind: "human", avatarUrl: null, retired: true } },
        { ...merged, appearance: { kind: "human", avatarUrl: null, retired: true } },
        visitor,
        cpu,
      ]),
      revision: 7,
    },
    {
      room_id: "other-room",
      host_name: "ホスト名",
      host_player_id: visitor.playerId,
      host_avatar_url: "/host",
      participants_json: JSON.stringify(participants),
      revision: 7,
    },
  ]);
  expect(actual.images).toEqual([
    { account_id: owner, key: "avatars/seat.webp" },
    { account_id: owner, key: "avatars/upload.webp" },
  ]);
  expect(actual.claims).toEqual([
    { match_id: "claim", player_id: "claimed", account_id: null, state: "retired" },
    { match_id: "claim", player_id: "visitor", account_id: other, state: "applied" },
    { match_id: "pending", player_id: "claimed", account_id: null, state: "retired" },
  ]);
  expectRetiredRecords(actual.matches);
  expectRetiredRecords(actual.uploads);
  expect(actual.history).toEqual([{ account_id: other, match_id: "direct" }]);
  expect(actual.sessions).toEqual([{ userId: other }]);
  expect(actual.profiles.find(({ id }) => id === owner)).toEqual({
    id: owner,
    name: retiredName,
    username: null,
    avatarKey: null,
    image: null,
    has_public_id: 0,
    profileCompleted: 0,
  });
  expect(actual.receipt).toEqual([
    { id: owner, receipt_hash: await digest(receipt), avatar_key: "avatars/profile.webp" },
  ]);

  for (const db of [withTriggers, withoutTriggers]) {
    // ジョブ消化後の再送で、削除済みの予約が復活するかを確認します。
    await db.batch([
      db.prepare("DELETE FROM deletion_rooms"),
      db.prepare("DELETE FROM deletion_images"),
    ]);
    const before = await state(db);
    expect(await requestDeletion({ ...env, APP_DB: db }, owner, receipt)).toBe(false);
    expect(await state(db)).toEqual(before);
  }
});

test("在室中で退会を受け付けない場合は連鎖の書き込みを実行しない", async () => {
  const db = withoutTriggers;
  const id = "deletion-while-seated";
  await accountFixture(true, id, db);
  await db.batch([
    feedback(db, "seated", id, "seated-hash"),
    db
      .prepare(`INSERT INTO account_room_seats
      (account_id,room_id,instance_id,player_id,operation_id,name,created_at_ms)
      VALUES (?,'host-room','instance','seated','deletion-seat','在室中',1)`)
      .bind(id),
    db.prepare("INSERT INTO privacy_avatar_uploads VALUES ('avatars/seated.webp',?,1)").bind(id),
  ]);
  const before = await state(db);

  expect(await requestDeletion({ ...env, APP_DB: db }, id, "seated-receipt")).toBe(false);

  expect(await state(db)).toEqual(before);
});

test("退会行の INSERT と連鎖の書き込みを同じ batch に入れる", async () => {
  const db = withTriggers;
  const id = "deletion-single-batch";
  await accountFixture(true, id, db);
  const captured = new WeakMap<D1PreparedStatement, string>();
  const prepare = db.prepare.bind(db);
  const spyPrepare = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    captured.set(stmt, sql);
    vi.spyOn(stmt, "bind").mockImplementation((...params) => {
      const bound = bind(...params);
      captured.set(bound, sql);
      return bound;
    });
    return stmt;
  });
  const spyBatch = vi.spyOn(db, "batch");
  try {
    expect(await requestDeletion({ ...env, APP_DB: db }, id, "batch-receipt")).toBe(true);
    expect(spyBatch).toHaveBeenCalledTimes(1);
    const sql = spyBatch.mock.calls[0][0].map((stmt) => captured.get(stmt)?.replace(/\s+/g, " "));
    expect(sql[0]).toMatch(/^INSERT INTO deleted_accounts\b/i);
    expect(sql.slice(1)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^UPDATE feedback .+\baccount_id\b/i),
        expect.stringMatching(/^UPDATE room_index SET host_name\b/i),
        expect.stringMatching(/^UPDATE room_index SET participants_json\b/i),
        expect.stringMatching(/^INSERT OR IGNORE INTO deletion_images .+\bprivacy_room_players\b/i),
        expect.stringMatching(
          /^INSERT OR IGNORE INTO deletion_images .+\bprivacy_avatar_uploads\b/i,
        ),
        expect.stringMatching(/^UPDATE match_participant_accounts SET state='retired'/i),
        expect.stringMatching(/^DELETE FROM account_match_history\b/i),
        expect.stringMatching(/^DELETE FROM session\b/i),
        expect.stringMatching(/^UPDATE user SET name\b/i),
      ]),
    );
    for (const table of ["matches", "match_uploads"])
      expect(
        sql.filter((s) => s?.startsWith(`UPDATE ${table} `) && s.includes("record_json =")),
      ).toHaveLength(2);
  } finally {
    spyBatch.mockRestore();
    spyPrepare.mockRestore();
  }
});
