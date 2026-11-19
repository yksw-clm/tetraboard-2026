import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { D1MatchRecordStore, publishMatchStatement } from "../src/adapters/record/matchRecordStore";
import {
  snapshotHistoryStatement,
  shogiHistoryStatement,
} from "../src/adapters/record/publication";
import { applyMatchClaims } from "../src/flows/matchSave/claims";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { advanceShogiMatchSave } from "../src/flows/matchSave/shogi";
import type { ShogiSaveProgress } from "../src/rooms/shogiMatchStore";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord } from "./shogiMatchFixtures";
import { standardShogiRecord } from "./standardShogiFixtures";
import { prepareStoredMatchFixture } from "./snapshotMatchFixtures";
import {
  guestMergeDb as db,
  seedMerge,
  storedRecord,
  history,
  testMigrations,
} from "./guestMergeRecordFixtures";

beforeAll(async () => {
  await applyD1Migrations(db, testMigrations);
});

function historyRows(
  matchId: string,
  game: string,
  mode: string,
  startedAtMs: number,
  accounts: string[],
) {
  return [...accounts].sort().map((accountId) => ({
    account_id: accountId,
    match_id: matchId,
    game,
    mode,
    started_at_ms: startedAtMs,
  }));
}

const retired = { accountId: null, name: "退会したプレイヤー", retired: true };

async function markDeleted(accountId: string) {
  await db
    .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,2000,?)")
    .bind(accountId, crypto.randomUUID())
    .run();
}

async function retireClaim(matchId: string, playerId: string) {
  await db
    .prepare(`INSERT INTO match_participant_accounts
      (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
      VALUES(?,?,NULL,'room','instance','retired',0,0)`)
    .bind(matchId, playerId)
    .run();
}

for (const [name, deletedAccount, retiredPlayer] of [
  ["退会なし", null, null],
  ["統合先が退会済み", "target", null],
  ["別の参加者が退会済み", "other", null],
  ["統合した席の引き継ぎが失効済み", null, "merged"],
  ["別の席の引き継ぎが失効済み", null, "other"],
] as const)
  test(`${name}の場合も、保存待ちと公開済みの棋譜・履歴を統合先と退会状態に合わせます`, async () => {
    const guest = crypto.randomUUID(),
      account = crypto.randomUUID(),
      other = crypto.randomUUID();
    const participants = [
      { id: "merged", kind: "human", accountId: guest, name: "統合前の名前", seat: 0 },
      { id: "other", kind: "human", accountId: other, name: "別の人", seat: 1 },
      { id: "guest", kind: "human", accountId: null, name: "未登録", seat: 2 },
      { id: "cpu", kind: "cpu", level: 2, name: "CPU", seat: 3 },
    ] as const;
    const record = {
      id: crypto.randomUUID(),
      settings: { game: "shogi" },
      startedAtMs: 1,
      endedAtMs: 2,
      replay: { eventCount: 0 },
      participants,
      profileRatings: { merged: { rating: 1500 }, other: { rating: 1600 } },
      untouched: { moves: [1, 2], result: "original" },
    };
    const json = JSON.stringify(record, null, 2);
    await seedMerge(db, guest, account);
    if (deletedAccount) await markDeleted(deletedAccount === "target" ? account : other);
    if (retiredPlayer) await retireClaim(record.id, retiredPlayer);

    const hideMerged = deletedAccount === "target" || retiredPlayer === "merged";
    const hideOther = deletedAccount === "other" || retiredPlayer === "other";
    const expectedJson = JSON.stringify({
      ...record,
      participants: [
        { ...participants[0], ...(hideMerged ? retired : { accountId: account }) },
        { ...participants[1], ...(hideOther ? retired : {}) },
        participants[2],
        participants[3],
      ],
    });
    const expectedHistory = historyRows(record.id, "shogi", "standard", 1, [
      ...(hideMerged ? [] : [account]),
      ...(hideOther ? [] : [other]),
    ]);

    const store = new D1MatchRecordStore(db);
    await store.insertUpload(record, json, 0);
    expect(await store.readUpload(record.id)).toBe(expectedJson);
    await db.batch([publishMatchStatement(db, record.id), shogiHistoryStatement(db, record.id)]);
    expect(await storedRecord(db, "matches", record.id)).toBe(expectedJson);
    expect(await history(db, record.id)).toEqual(expectedHistory);

    await store.insertUpload(record, json.replace("original", "retry"), 0);
    await db.batch([publishMatchStatement(db, record.id), shogiHistoryStatement(db, record.id)]);
    expect(await store.readUpload(record.id)).toBe(expectedJson);
    expect(await storedRecord(db, "matches", record.id)).toBe(expectedJson);
    expect(await history(db, record.id)).toEqual(expectedHistory);
  });

test("対応なしのJSONは表記を保ち、空の参加者・null・欠落したID・CPUも保持します", async () => {
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
    const store = new D1MatchRecordStore(db);
    await store.insertUpload(record, json, 0);
    await store.publication(record.id).run();
    expect(await store.readUpload(record.id)).toBe(json);
    expect(await storedRecord(db, "matches", record.id)).toBe(json);
  }
});

test("アップロード後に統合された対局も公開時に統合先へ書き換えます", async () => {
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
  const store = new D1MatchRecordStore(db);
  const json = JSON.stringify(record);
  await store.insertUpload(record, json, 0);
  expect(await store.readUpload(record.id)).toBe(json);
  await seedMerge(db, guest, account);
  await db.batch([store.publication(record.id), shogiHistoryStatement(db, record.id)]);

  expect(await storedRecord(db, "matches", record.id)).toBe(
    JSON.stringify({
      ...record,
      participants: [{ ...record.participants[0], accountId: account }],
    }),
  );
  expect(await history(db, record.id)).toEqual(
    historyRows(record.id, "shogi", "standard", 1, [account]),
  );
});

for (const { name, retiredPlayer } of [
  { name: "統合先が退会済み", retiredPlayer: null },
  { name: "統合した席の引き継ぎが失効済み", retiredPlayer: "merged" },
  { name: "別の席の引き継ぎが失効済み", retiredPlayer: "other" },
] as const)
  test(`${name}の場合に古いアップロードを公開しても退会済みの参加者を伏せます`, async () => {
    const guest = crypto.randomUUID(),
      account = crypto.randomUUID();
    const mergedPlayer = { id: "merged", kind: "human", accountId: guest, name: "統合前" };
    const otherPlayer = { id: "other", kind: "human", accountId: null, name: "別の人" };
    const record = {
      id: crypto.randomUUID(),
      settings: { game: "shogi" },
      startedAtMs: 1,
      endedAtMs: 2,
      participants: [mergedPlayer, otherPlayer],
      replay: { eventCount: 0 },
    };
    const store = new D1MatchRecordStore(db);
    await store.insertUpload(record, JSON.stringify(record), 0);
    await seedMerge(db, guest, account);
    if (retiredPlayer === null) await markDeleted(account);
    else await retireClaim(record.id, retiredPlayer);

    await db.batch([store.publication(record.id), shogiHistoryStatement(db, record.id)]);
    const keepMerged = retiredPlayer === "other";
    expect(await storedRecord(db, "matches", record.id)).toBe(
      JSON.stringify({
        ...record,
        participants: [
          { ...mergedPlayer, ...(keepMerged ? { accountId: account } : retired) },
          { ...otherPlayer, ...(keepMerged ? retired : {}) },
        ],
      }),
    );
    expect(await history(db, record.id)).toEqual(
      historyRows(record.id, "shogi", "standard", 1, keepMerged ? [account] : []),
    );
  });

test("複数の統合済みゲストをそれぞれの統合先へ置き換え、席の順序を保ちます", async () => {
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
  for (let i = 0; i < guests.length; i++) await seedMerge(db, guests[i], accounts[i]);
  const store = new D1MatchRecordStore(db);
  const expected = JSON.stringify({
    ...record,
    participants: record.participants.map((p, i) => ({ ...p, accountId: accounts[i] })),
  });
  await store.insertUpload(record, JSON.stringify(record), 0);
  expect(await store.readUpload(record.id)).toBe(expected);
  await db.batch([store.publication(record.id), shogiHistoryStatement(db, record.id)]);
  expect(await storedRecord(db, "matches", record.id)).toBe(expected);
  expect(await history(db, record.id)).toEqual(
    historyRows(record.id, "shogi", "standard", 1, accounts),
  );
});

for (const [name, statement] of [
  ["スナップショット", snapshotHistoryStatement],
  ["将棋", shogiHistoryStatement],
] as const)
  for (const deleted of [false, true])
    test(`${name}で履歴だけが遅れて挿入される場合に${deleted ? "退会済みの統合先の行を残しません" : "統合先の1行にまとめます"}`, async () => {
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
      await db
        .prepare("INSERT INTO matches VALUES(?,'shogi','standard',1,2,?)")
        .bind(id, json)
        .run();
      await seedMerge(db, guest, account);
      if (deleted) await markDeleted(account);
      const expectedHistory = historyRows(id, "shogi", "standard", 1, deleted ? [] : [account]);
      await statement(db, id).run();
      expect(await history(db, id)).toEqual(expectedHistory);
      await statement(db, id).run();
      expect(await history(db, id)).toEqual(expectedHistory);
    });

test("引き継ぎ適用で履歴を統合先に挿入し、再適用でも1行を保ちます", async () => {
  const guest = crypto.randomUUID(),
    account = crypto.randomUUID();
  const record = humanFixtureRecord(guest, 1);
  for (const p of record.participants) if (p.kind === "human") p.accountId = null;
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
  const expectedHistory = historyRows(record.id, "four-reversi", "singles", record.startedAtMs, [
    account,
  ]);
  await applyMatchClaims(db, record.id);
  expect(await history(db, record.id)).toEqual(expectedHistory);
  await applyMatchClaims(db, record.id);
  expect(await history(db, record.id)).toEqual(expectedHistory);
});

for (const game of ["four-reversi", "shogi", "four-shogi"] as const)
  test(`${game}の保存で棋譜・履歴を統合先へ書き換え、再送後も保ちます`, async () => {
    const guest = crypto.randomUUID(),
      account = crypto.randomUUID();
    const source = game === "shogi" ? standardShogiRecord(guest) : humanShogiRecord(guest);
    const snapshot = humanFixtureRecord(guest, 1);
    const record = game === "four-reversi" ? snapshot : source.record;
    const { id } = record;
    const save = async () => {
      if (game === "four-reversi") return writeMatch(db, snapshot);
      let progress: ShogiSaveProgress | null = { phase: "upload", cursor: 0 };
      while (progress)
        progress = await advanceShogiMatchSave(db, source.record, progress, (cursor) =>
          source.events.slice(cursor, cursor + 100),
        );
    };

    await seedMerge(db, guest, account);
    await save();
    const saved = await storedRecord(db, "matches", id);
    expect(JSON.parse(saved!).participants).toEqual(
      record.participants.map((p) =>
        p.kind === "human" && p.accountId === guest ? { ...p, accountId: account } : p,
      ),
    );
    const expectedHistory = historyRows(
      id,
      game,
      game === "shogi" ? "standard" : "singles",
      record.startedAtMs,
      [account],
    );
    expect(await history(db, id)).toEqual(expectedHistory);
    expect(await storedRecord(db, "match_uploads", id)).toBeNull();

    await save();
    expect(await storedRecord(db, "matches", id)).toBe(saved);
    expect(await history(db, id)).toEqual(expectedHistory);
    expect(await storedRecord(db, "match_uploads", id)).toBeNull();
  });
