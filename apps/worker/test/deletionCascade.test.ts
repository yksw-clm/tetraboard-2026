import { env } from "cloudflare:test";
import { expect, onTestFinished, test, vi } from "vitest";
import { digest } from "../src/crypto";
import { feedbackAccountHash } from "../src/flows/accountPurge/feedbackAccountHash";
import { processDeletions } from "../src/flows/accountPurge/processDeletions";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { accountFixture } from "./accountFixtures";
import { privacyConcurrencyFixture } from "./privacyConcurrencyFixture";

const db = env.APP_DB;
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

async function state(accountId = owner, database = db) {
  const db = database;
  const statements = {
    feedback: db.prepare(
      "SELECT id,deleted FROM feedback WHERE id IN ('direct','hashed','other','seated') ORDER BY id",
    ),
    rooms: db.prepare(
      "SELECT room_id,host_name,host_avatar_url,host_player_id,participants_json,revision FROM room_index WHERE room_id IN ('host-room','other-room') ORDER BY room_id",
    ),
    images: db
      .prepare("SELECT account_id,key FROM deletion_images WHERE account_id=? ORDER BY key")
      .bind(accountId),
    queuedRooms: db
      .prepare("SELECT room_id FROM deletion_rooms WHERE account_id=? ORDER BY room_id")
      .bind(accountId),
    claims: db.prepare(
      "SELECT match_id,player_id,account_id,state FROM match_participant_accounts WHERE match_id IN ('claim','pending') ORDER BY match_id,player_id",
    ),
    matches: db
      .prepare("SELECT id,record_json FROM matches WHERE id IN (?,?,?) ORDER BY id")
      .bind(...Object.keys(playerCases)),
    uploads: db
      .prepare("SELECT id,record_json FROM match_uploads WHERE id IN (?,?,?) ORDER BY id")
      .bind(...Object.keys(playerCases)),
    history: db
      .prepare(
        "SELECT account_id,match_id FROM account_match_history WHERE account_id IN (?,?) ORDER BY account_id",
      )
      .bind(accountId, other),
    sessions: db
      .prepare("SELECT userId FROM session WHERE userId IN (?,?) ORDER BY userId")
      .bind(accountId, other),
    profiles: db
      .prepare(
        "SELECT id,name,username,avatarKey,image,publicProfileId IS NOT NULL AS has_public_id,profileCompleted FROM user WHERE id IN (?,?) ORDER BY id",
      )
      .bind(accountId, other),
    receipt: db
      .prepare("SELECT id,receipt_hash,avatar_key FROM deleted_accounts WHERE id=?")
      .bind(accountId),
  };
  const result = await db.batch(Object.values(statements));
  return Object.fromEntries(
    Object.keys(statements).map((name, index) => [name, result[index].results]),
  ) as Record<keyof typeof statements, Record<string, unknown>[]>;
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

test("退会受付の batch で本人情報を削除・伏せ字にし、再送しても削除予約を復活させない", async () => {
  await seed(db);
  const before = await state();
  await db
    .prepare("UPDATE privacy_avatar_uploads SET started_at_ms=? WHERE account_id=?")
    .bind(Date.now(), owner)
    .run();
  const { results: indexedRooms } = await db
    .prepare(
      "SELECT room_id FROM room_index UNION SELECT room_id FROM room_index_deleted_revisions ORDER BY room_id",
    )
    .all();
  expect(await requestDeletion(env, owner, receipt)).toBe(true);

  const actual = await state();
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
  expect(actual.queuedRooms).toEqual(indexedRooms);
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
  expect(actual.profiles.find(({ id }) => id === other)).toEqual(
    before.profiles.find(({ id }) => id === other),
  );
  expect(actual.receipt).toEqual([
    { id: owner, receipt_hash: await digest(receipt), avatar_key: "avatars/profile.webp" },
  ]);

  // 画像の書き込み待ちの間に定期処理を起動しても、受付時の状態を保ちます。
  await processDeletions(env);
  expect(await state()).toEqual(actual);

  // ジョブ消化後の再送で、削除済みの予約が復活しないことを確認します。
  await db.batch([
    db.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(owner),
    db.prepare("DELETE FROM deletion_images WHERE account_id=?").bind(owner),
  ]);
  expect(await requestDeletion(env, owner, receipt)).toBe(false);
  expect(await state()).toEqual({ ...actual, queuedRooms: [], images: [] });
});

test("復元した退会台帳を未完了に戻すと、定期処理が旧データを再度伏せ字にする", async () => {
  const { db } = await privacyConcurrencyFixture();
  const bindings = { ...env, APP_DB: db };
  await accountFixture(true, owner, db);
  expect(await requestDeletion(bindings, owner, receipt)).toBe(true);
  await processDeletions(bindings);
  const ledger = (await db
    .prepare(
      "SELECT requested_at_ms,completed_at_ms,receipt_hash,last_attempted_at_ms FROM deleted_accounts WHERE id=?",
    )
    .bind(owner)
    .first<{
      requested_at_ms: number;
      completed_at_ms: number | null;
      receipt_hash: string;
      last_attempted_at_ms: number;
    }>())!;
  expect(ledger.completed_at_ms).toEqual(expect.any(Number));

  // バックアップ時点のデータを戻してから、完了済みの台帳を未完了にして入れ直します。
  await db.prepare("DELETE FROM deleted_accounts WHERE id=?").bind(owner).run();
  await seed(db);
  const restoredAvatar = `avatars/${crypto.randomUUID()}.webp`;
  await env.OBJECT_STORAGE.put(restoredAvatar, "復元された画像");
  onTestFinished(async () => {
    await env.OBJECT_STORAGE.delete(restoredAvatar);
  });
  await db.batch([
    db.prepare("UPDATE user SET avatarKey=? WHERE id=?").bind(restoredAvatar, owner),
    db
      .prepare("UPDATE privacy_avatar_uploads SET started_at_ms=? WHERE account_id=?")
      .bind(Date.now(), owner),
    db
      .prepare(`INSERT INTO deleted_accounts
      (id,requested_at_ms,completed_at_ms,receipt_hash,last_attempted_at_ms)
      VALUES (?,?,NULL,?,?)`)
      .bind(owner, ledger.requested_at_ms, ledger.receipt_hash, ledger.last_attempted_at_ms),
  ]);
  const restored = await state(owner, db);
  expect(restored.rooms[0]).toMatchObject({ host_name: "ホスト名" });

  await processDeletions(bindings);

  const pending = await state(owner, db);
  expect(pending.rooms[0]).toMatchObject({
    host_name: retiredName,
    host_player_id: null,
    host_avatar_url: null,
    participants_json: JSON.stringify([
      { ...host, appearance: { kind: "human", avatarUrl: null, retired: true } },
      { ...merged, appearance: { kind: "human", avatarUrl: null, retired: true } },
      visitor,
      cpu,
    ]),
  });
  expect(pending.rooms[1]).toEqual(restored.rooms[1]);
  expectRetiredRecords(pending.matches);
  expectRetiredRecords(pending.uploads);
  expect(pending.claims).toEqual([
    { match_id: "claim", player_id: "claimed", account_id: null, state: "retired" },
    { match_id: "claim", player_id: "visitor", account_id: other, state: "applied" },
    { match_id: "pending", player_id: "claimed", account_id: null, state: "retired" },
  ]);
  expect(pending.feedback).toEqual([
    { id: "direct", deleted: 1 },
    { id: "hashed", deleted: 1 },
    { id: "other", deleted: 0 },
  ]);
  expect(pending.history).toEqual([{ account_id: other, match_id: "direct" }]);
  expect(pending.sessions).toEqual([{ userId: other }]);
  expect(pending.profiles.find(({ id }) => id === owner)).toMatchObject({
    name: retiredName,
    username: null,
    avatarKey: null,
    image: null,
    has_public_id: 0,
    profileCompleted: 0,
  });
  expect(pending.images.map(({ key }) => key)).toEqual(
    [restoredAvatar, "avatars/seat.webp", "avatars/upload.webp"].sort(),
  );
  expect(pending.receipt).toEqual(restored.receipt);

  await db
    .prepare("UPDATE privacy_avatar_uploads SET started_at_ms=1 WHERE account_id=?")
    .bind(owner)
    .run();
  await processDeletions(bindings);
  expect(await env.OBJECT_STORAGE.get(restoredAvatar)).toBeNull();
  const done = await state(owner, db);
  expect(done).toEqual({
    ...pending,
    feedback: [{ id: "other", deleted: 0 }],
    images: [],
    profiles: restored.profiles.filter(({ id }) => id === other),
  });
  expect(
    await db.prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?").bind(owner).first(),
  ).toEqual({ completed_at_ms: expect.any(Number) });
});

test("在室中で退会を受け付けない場合は連鎖の書き込みを実行しない", async () => {
  const id = "deletion-while-seated";
  await accountFixture(true, id, db);
  onTestFinished(async () => {
    await db.prepare("DELETE FROM account_room_seats WHERE account_id=?").bind(id).run();
  });
  await db.batch([
    feedback(db, "seated", id, "seated-hash"),
    db
      .prepare(`INSERT INTO account_room_seats
      (account_id,room_id,instance_id,player_id,operation_id,name,created_at_ms)
      VALUES (?,'host-room','instance','seated','deletion-seat','在室中',1)`)
      .bind(id),
    db.prepare("INSERT INTO privacy_avatar_uploads VALUES ('avatars/seated.webp',?,1)").bind(id),
  ]);
  const before = await state(id);

  expect(await requestDeletion(env, id, "seated-receipt")).toBe(false);

  expect(await state(id)).toEqual(before);
});

test("退会行の INSERT と連鎖の書き込みを同じ batch に入れる", async () => {
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
    expect(await requestDeletion(env, id, "batch-receipt")).toBe(true);
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
