import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { participantProfiles } from "../src/accounts/matchProfiles";
import { matchSummary, readStoredMatch } from "../src/accounts/matchDataContracts";
import { accountFixture } from "./accountFixtures";
import { fixtureRecord, humanFixtureRecord } from "./matchFixtures";

function countQueries(db: D1Database) {
  let count = 0;
  const measured = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          count++;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: measured, count: () => count };
}

for (const count of [1, 20]) {
  test(`${count}件の対局の現在プロフィールを4回以内のDB問い合わせで取得する`, async () => {
    const user = await accountFixture();
    const records = Array.from({ length: count }, (_, index) =>
      readStoredMatch(JSON.stringify(fixtureRecord(user.id, index + 1)), "four-reversi"),
    );
    const measured = countQueries(env.APP_DB);

    const profiles = await participantProfiles(measured.db, records);

    expect(profiles.get(user.id)).toEqual({ name: "登録名", avatarUrl: null });
    for (const record of records) {
      expect(matchSummary(record, profiles).participants.map((p) => p.name)).toEqual([
        "登録名",
        "ゲスト",
        "CPU Lv1",
        "CPU Lv2",
      ]);
    }
    // 時間の閾値ではなく、D1への往復が対局数に比例して増えないことを検証する。
    expect(measured.count()).toBeLessThanOrEqual(4);
  });
}

test("空の一覧ではDBへ問い合わせない", async () => {
  const measured = countQueries(env.APP_DB);

  const profiles = await participantProfiles(measured.db, []);

  expect(profiles.size).toBe(0);
  expect(measured.count()).toBe(0);
});

test("20件すべてが異なる登録者4人の対局でもD1のバインド上限内で取得する", async () => {
  const namespace = crypto.randomUUID();
  const records = Array.from({ length: 20 }, (_, index) => {
    const record = humanFixtureRecord(namespace, index + 1);
    for (const player of record.participants)
      if (player.kind === "human") player.accountId = crypto.randomUUID();
    return readStoredMatch(JSON.stringify(record), "four-reversi");
  });
  const measured = countQueries(env.APP_DB);

  const profiles = await participantProfiles(measured.db, records);

  expect(profiles.size).toBe(0);
  expect(records).toHaveLength(20);
  expect(measured.count()).toBeLessThanOrEqual(4);
});

test("対局ごとの登録引き継ぎ・退会を重ね、未確定の受付と別の対局の同じ参加者IDを混同しない", async () => {
  const owner = await accountFixture();
  const claimed = await accountFixture();
  const deleted = await accountFixture();
  const avatarKey = `avatars/${crypto.randomUUID()}.webp`;
  await env.APP_DB.prepare("UPDATE user SET name=?,avatarKey=? WHERE id=?")
    .bind("現在の名前", avatarKey, owner.id)
    .run();
  const playerId = crypto.randomUUID();
  const snapshots = Array.from({ length: 4 }, (_, index) => {
    const record = humanFixtureRecord(owner.id, index + 1);
    record.participants[1].id = playerId;
    return record;
  });
  const native = snapshots[0].participants[2];
  const missing = snapshots[0].participants[3];
  const retired = snapshots[3].participants[2];
  if (native.kind !== "human" || missing.kind !== "human" || retired.kind !== "human")
    throw new Error("Expected human fixtures");
  native.accountId = deleted.id;
  native.name = "退会前の名前";
  missing.accountId = crypto.randomUUID();
  missing.name = "参照先のない保存名";
  retired.retired = true;
  retired.name = "退会したプレイヤー";
  const records = snapshots.map((record) =>
    readStoredMatch(JSON.stringify(record), "four-reversi"),
  );
  for (const [index, state] of ["applied", "retired", "pending", "rejected"].entries()) {
    const record = snapshots[index];
    await env.APP_DB.prepare(`INSERT INTO match_participant_accounts
      (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
      VALUES(?,?,?,?,?,?,0,0)`)
      .bind(
        record.id,
        playerId,
        state === "applied" || state === "pending" ? claimed.id : null,
        record.roomId,
        record.instanceId,
        state,
      )
      .run();
  }
  // 退会済みの保存参加者に古いapplied関係が残っても、本人として復活させない。
  await env.APP_DB.prepare(`INSERT INTO match_participant_accounts
    (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
    VALUES(?,?,?,?,?,'applied',0,0)`)
    .bind(snapshots[3].id, retired.id, owner.id, snapshots[3].roomId, snapshots[3].instanceId)
    .run();
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,0,?)",
  )
    .bind(deleted.id, crypto.randomUUID())
    .run();

  const profiles = await participantProfiles(env.APP_DB, records);

  expect(profiles.get(owner.id)).toEqual({
    name: "現在の名前",
    avatarUrl: `/api/avatars/${avatarKey.slice(8, -5)}`,
  });
  expect(profiles.has(deleted.id)).toBe(false);
  const summaries = records.map((record) => matchSummary(record, profiles));
  expect(summaries.map((summary) => summary.participants[1].name)).toEqual([
    "登録名",
    "退会したプレイヤー",
    "ゲスト",
    "ゲスト",
  ]);
  expect(summaries[0].participants[2]).toMatchObject({
    name: "退会したプレイヤー",
    avatarUrl: null,
    retired: true,
  });
  expect(summaries[0].participants[3]).toMatchObject({
    name: "参照先のない保存名",
    avatarUrl: null,
  });
  expect(summaries[3].participants[2]).toMatchObject({
    name: "退会したプレイヤー",
    retired: true,
  });
  expect(JSON.stringify(summaries)).not.toContain("退会前の名前");
  for (const id of [owner.id, claimed.id, deleted.id, missing.accountId])
    expect(JSON.stringify(summaries)).not.toContain(id);
  expect(snapshots[0].participants[1]).toMatchObject({ accountId: null, name: "ゲスト" });
});

test("保存された本人と引き継ぎ先が矛盾する対局の一覧を返さない", async () => {
  const owner = await accountFixture();
  const other = await accountFixture();
  const record = fixtureRecord(owner.id, 1);
  await env.APP_DB.prepare(`INSERT INTO match_participant_accounts
    (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
    VALUES(?,?,?,?,?,'applied',0,0)`)
    .bind(record.id, record.participants[0].id, other.id, record.roomId, record.instanceId)
    .run();

  await expect(
    participantProfiles(env.APP_DB, [readStoredMatch(JSON.stringify(record), "four-reversi")]),
  ).rejects.toThrow("Conflicting match participant identity");
});
