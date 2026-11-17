import { expect, test } from "vitest";
import { D1MatchRecordStore, publishMatchStatement } from "../src/adapters/record/matchRecordStore";
import {
  snapshotHistoryStatement,
  shogiHistoryStatement,
} from "../src/adapters/record/publication";
import { applyMatchClaims } from "../src/accounts/matchClaims";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { advanceShogiMatchSave } from "../src/flows/matchSave/shogi";
import type { ShogiSaveProgress } from "../src/rooms/shogiMatchStore";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord } from "./shogiMatchFixtures";
import { standardShogiRecord } from "./standardShogiFixtures";
import { prepareStoredMatchFixture } from "./snapshotMatchFixtures";
import {
  databases,
  withTriggers,
  withoutTriggers,
  mergeTriggers,
  seedMerge,
  storedRecord,
  history,
  clearRecord,
  legacyPublication,
  legacyHistory,
} from "./guestMergeRecordFixtures";

test("専用DBだけで統合トリガー3つを外し、退会トリガーは保持する", async () => {
  const triggers = async (db: D1Database) =>
    (
      await db
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
        .all<{ name: string; sql: string }>()
    ).results;
  const before = await triggers(withTriggers);
  expect(mergeTriggers.every((name) => before.some((t) => t.name === name))).toBe(true);
  expect(await triggers(withoutTriggers)).toEqual(
    before.filter((t) => !mergeTriggers.includes(t.name)),
  );
});

for (const privacy of [
  "none",
  "deleted-target",
  "deleted-other",
  "retired-same",
  "retired-other",
] as const)
  test(`${privacy}: 旧INSERT＋トリガーと、新INSERTのトリガー有無でJSON・履歴が一致する`, async () => {
    const guest = crypto.randomUUID(),
      account = crypto.randomUUID(),
      other = crypto.randomUUID();
    const record = {
      id: crypto.randomUUID(),
      settings: { game: "shogi" },
      startedAtMs: 1,
      endedAtMs: 2,
      replay: { eventCount: 0 },
      participants: [
        { id: "merged", kind: "human", accountId: guest, name: "統合前の名前", seat: 0 },
        { id: "other", kind: "human", accountId: other, name: "別の人", seat: 1 },
        { id: "guest", kind: "human", accountId: null, name: "未登録", seat: 2 },
        { id: "cpu", kind: "cpu", level: 2, name: "CPU", seat: 3 },
      ],
      profileRatings: { merged: { rating: 1500 }, other: { rating: 1600 } },
      untouched: { moves: [1, 2], result: "original" },
    };
    const json = JSON.stringify(record, null, 2);
    for (const db of databases) {
      await seedMerge(db, guest, account);
      if (privacy.startsWith("deleted"))
        await db
          .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,2000,?)")
          .bind(privacy === "deleted-target" ? account : other, crypto.randomUUID())
          .run();
      if (privacy.startsWith("retired"))
        await db
          .prepare(`INSERT INTO match_participant_accounts
        (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
        VALUES(?,?,NULL,'room','instance','retired',0,0)`)
          .bind(record.id, privacy === "retired-same" ? "merged" : "other")
          .run();
    }
    await withTriggers
      .prepare("INSERT INTO match_uploads VALUES(?,?,0,0)")
      .bind(record.id, json)
      .run();
    const expectedUpload = await storedRecord(withTriggers, "match_uploads", record.id);
    await withTriggers.batch([
      legacyPublication(withTriggers, record.id),
      legacyHistory(withTriggers, record.id),
    ]);
    const expectedMatch = await storedRecord(withTriggers, "matches", record.id);
    const expectedHistory = await history(withTriggers, record.id);
    await clearRecord(withTriggers, record.id);
    for (const db of databases) {
      const store = new D1MatchRecordStore(db);
      await store.insertUpload(record, json, 0);
      expect(await store.readUpload(record.id)).toBe(expectedUpload);
      await db.batch([publishMatchStatement(db, record.id), shogiHistoryStatement(db, record.id)]);
      expect(await storedRecord(db, "matches", record.id)).toBe(expectedMatch);
      expect(await history(db, record.id)).toEqual(expectedHistory);
      // 再送は保存済みの内容を変えません。
      await store.insertUpload(record, json.replace("original", "retry"), 0);
      await db.batch([publishMatchStatement(db, record.id), shogiHistoryStatement(db, record.id)]);
      expect(await store.readUpload(record.id)).toBe(expectedUpload);
      expect(await history(db, record.id)).toEqual(expectedHistory);
    }
    const saved = JSON.parse(expectedMatch!);
    const hidden = privacy === "deleted-target" || privacy === "retired-same";
    expect(saved.participants[0]).toMatchObject(
      hidden
        ? { accountId: null, name: "退会したプレイヤー", retired: true }
        : { accountId: account, name: "統合前の名前" },
    );
    if (privacy === "deleted-other" || privacy === "retired-other")
      expect(saved.participants[1]).toMatchObject({ accountId: null, retired: true });
    expect(saved.profileRatings).toEqual(record.profileRatings);
    expect(expectedHistory.some((row) => row.account_id === guest)).toBe(false);
  });

test("対応なしのJSONは表記を保ち、空の参加者・null・欠落したID・CPUも保持する", async () => {
  for (const participants of [[], [{ kind: "human", accountId: null }, { kind: "cpu" }]]) {
    const record = {
      id: crypto.randomUUID(),
      settings: { game: "shogi" },
      startedAtMs: 1,
      endedAtMs: 2,
      participants,
      replay: { eventCount: 0 },
    };
    const json = JSON.stringify(record, null, 2);
    for (const db of databases) {
      const store = new D1MatchRecordStore(db);
      await store.insertUpload(record, json, 0);
      await store.publication(record.id).run();
      expect(await store.readUpload(record.id)).toBe(json);
      expect(await storedRecord(db, "matches", record.id)).toBe(json);
    }
  }
});

test("アップロード後に統合された対局も、公開INSERTで統合先に書き換える", async () => {
  const guest = crypto.randomUUID(),
    account = crypto.randomUUID();
  const record = {
    id: crypto.randomUUID(),
    settings: { game: "shogi" },
    startedAtMs: 1,
    endedAtMs: 2,
    replay: { eventCount: 0 },
    participants: [{ kind: "human", accountId: guest, name: "名前" }],
  };
  for (const db of databases) {
    const store = new D1MatchRecordStore(db);
    await store.insertUpload(record, JSON.stringify(record), 0);
    await seedMerge(db, guest, account);
    await db.batch([store.publication(record.id), shogiHistoryStatement(db, record.id)]);
    expect(
      JSON.parse((await storedRecord(db, "matches", record.id))!).participants[0].accountId,
    ).toBe(account);
    expect((await history(db, record.id)).map((r) => r.account_id)).toEqual([account]);
  }
  expect(await storedRecord(withoutTriggers, "matches", record.id)).toBe(
    await storedRecord(withTriggers, "matches", record.id),
  );
});

for (const privacy of ["deleted-target", "retired-same", "retired-other"] as const)
  test(`${privacy}: 古いアップロードを公開するときも統合UPDATE経由の退会処理と一致する`, async () => {
    const guest = crypto.randomUUID(),
      account = crypto.randomUUID();
    const record = {
      id: crypto.randomUUID(),
      settings: { game: "shogi" },
      startedAtMs: 1,
      endedAtMs: 2,
      participants: [
        { id: "merged", kind: "human", accountId: guest, name: "統合前" },
        { id: "other", kind: "human", accountId: null, name: "別の人" },
      ],
    };
    for (const db of databases) {
      // 統合も退会もまだない時点のアップロードを残します。
      await db
        .prepare("INSERT INTO match_uploads VALUES(?,?,0,0)")
        .bind(record.id, JSON.stringify(record))
        .run();
      await seedMerge(db, guest, account);
      if (privacy === "deleted-target")
        await db
          .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,2000,?)")
          .bind(account, crypto.randomUUID())
          .run();
      else
        await db
          .prepare(`INSERT INTO match_participant_accounts
          (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
          VALUES(?,?,NULL,'room','instance','retired',0,0)`)
          .bind(record.id, privacy === "retired-same" ? "merged" : "other")
          .run();
    }
    await withTriggers.batch([
      legacyPublication(withTriggers, record.id),
      legacyHistory(withTriggers, record.id),
    ]);
    const expected = await storedRecord(withTriggers, "matches", record.id);
    const expectedHistory = await history(withTriggers, record.id);
    await withTriggers
      .prepare("DELETE FROM account_match_history WHERE match_id=?")
      .bind(record.id)
      .run();
    await withTriggers.prepare("DELETE FROM matches WHERE id=?").bind(record.id).run();
    for (const db of databases) {
      await db.batch([publishMatchStatement(db, record.id), shogiHistoryStatement(db, record.id)]);
      expect(await storedRecord(db, "matches", record.id)).toBe(expected);
      expect(await history(db, record.id)).toEqual(expectedHistory);
    }
    const players = JSON.parse(expected!).participants;
    expect(players[privacy === "retired-other" ? 1 : 0]).toMatchObject({
      accountId: null,
      name: "退会したプレイヤー",
      retired: true,
    });
  });

test("複数の統合済みゲストをそれぞれの統合先へ置き換え、席の順序を保つ", async () => {
  const guests = [crypto.randomUUID(), crypto.randomUUID()];
  const accounts = [crypto.randomUUID(), crypto.randomUUID()];
  const record = {
    id: crypto.randomUUID(),
    settings: { game: "shogi" },
    startedAtMs: 1,
    endedAtMs: 2,
    replay: { eventCount: 0 },
    participants: guests.map((accountId, seat) => ({
      id: `player-${seat}`,
      kind: "human",
      accountId,
      name: `名前${seat}`,
      seat,
    })),
  };
  for (const db of databases) {
    for (let i = 0; i < guests.length; i++) await seedMerge(db, guests[i], accounts[i]);
    const store = new D1MatchRecordStore(db);
    await store.insertUpload(record, JSON.stringify(record), 0);
    expect(JSON.parse((await store.readUpload(record.id))!).participants).toEqual(
      record.participants.map((p, i) => ({ ...p, accountId: accounts[i] })),
    );
    await db.batch([store.publication(record.id), shogiHistoryStatement(db, record.id)]);
    expect((await history(db, record.id)).map((r) => r.account_id)).toEqual([...accounts].sort());
  }
  expect(await storedRecord(withoutTriggers, "matches", record.id)).toBe(
    await storedRecord(withTriggers, "matches", record.id),
  );
});

for (const statement of [snapshotHistoryStatement, shogiHistoryStatement])
  for (const deleted of [false, true])
    test(`${statement.name}: 履歴だけが遅れて挿入されても統合先の1行になり、退会後は残さない (${deleted})`, async () => {
      const guest = crypto.randomUUID(),
        account = crypto.randomUUID(),
        id = crypto.randomUUID();
      const json = JSON.stringify({
        participants: [
          { kind: "human", accountId: guest },
          { kind: "human", accountId: account },
          { kind: "human", accountId: null },
          { kind: "cpu" },
        ],
      });
      for (const db of databases) {
        await db
          .prepare("INSERT INTO matches VALUES(?,'shogi','standard',1,2,?)")
          .bind(id, json)
          .run();
        await seedMerge(db, guest, account);
        if (deleted)
          await db
            .prepare(
              "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,2000,?)",
            )
            .bind(account, crypto.randomUUID())
            .run();
      }
      await legacyHistory(withTriggers, id).run();
      const expected = await history(withTriggers, id);
      await withTriggers
        .prepare("DELETE FROM account_match_history WHERE match_id=?")
        .bind(id)
        .run();
      for (const db of databases) {
        await statement(db, id).run();
        await statement(db, id).run();
        expect(await history(db, id)).toEqual(expected);
        expect((await history(db, id)).map((r) => r.account_id)).toEqual(deleted ? [] : [account]);
      }
    });

test("引き継ぎ適用の履歴も統合先に挿入し、再適用で増やさない", async () => {
  const guest = crypto.randomUUID(),
    account = crypto.randomUUID();
  const record = humanFixtureRecord(guest, 1);
  for (const p of record.participants) if (p.kind === "human") p.accountId = null;
  for (const db of databases) {
    const json = await prepareStoredMatchFixture(db, JSON.stringify(record));
    await db
      .prepare("INSERT INTO matches VALUES(?,'four-reversi','singles',?,?,?)")
      .bind(record.id, record.startedAtMs, record.endedAtMs, json)
      .run();
    await seedMerge(db, guest, account);
    await db
      .prepare(`INSERT INTO match_participant_accounts
      (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
      VALUES(?,?,?,?,?,'pending',0,0)`)
      .bind(record.id, record.participants[0].id, guest, record.roomId, record.instanceId)
      .run();
    await applyMatchClaims(db, record.id);
    await applyMatchClaims(db, record.id);
    expect((await history(db, record.id)).map((r) => r.account_id)).toEqual([account]);
  }
  expect(await history(withoutTriggers, record.id)).toEqual(await history(withTriggers, record.id));
});

for (const game of ["four-reversi", "shogi", "four-shogi"] as const)
  test(`${game}: 既存fixtureの保存・再送経路でも統合後の本体・履歴が一致する`, async () => {
    const guest = crypto.randomUUID(),
      account = crypto.randomUUID();
    const source = game === "shogi" ? standardShogiRecord(guest) : humanShogiRecord(guest);
    const snapshot = humanFixtureRecord(guest, 1);
    const id = game === "four-reversi" ? snapshot.id : source.record.id;
    for (const db of databases) {
      await seedMerge(db, guest, account);
      for (let retry = 0; retry < 2; retry++) {
        if (game === "four-reversi") await writeMatch(db, snapshot);
        else {
          let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
          while (progress)
            progress = await advanceShogiMatchSave(db, source.record, progress, (cursor) =>
              source.events.slice(cursor, cursor + 100),
            );
        }
      }
      expect(await storedRecord(db, "match_uploads", id)).toBeNull();
      expect((await history(db, id)).map((r) => r.account_id)).toEqual([account]);
    }
    expect(await storedRecord(withoutTriggers, "matches", id)).toBe(
      await storedRecord(withTriggers, "matches", id),
    );
    expect(await history(withoutTriggers, id)).toEqual(await history(withTriggers, id));
  });
