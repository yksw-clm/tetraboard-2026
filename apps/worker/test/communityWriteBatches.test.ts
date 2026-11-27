// 実行した経路が D1 の batch に渡す SQL の形と順序を正規表現で検査します。未実行の分岐は対象外です。
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import type { AnnouncementInput } from "@tetraboard/protocol";
import { create, update } from "../src/adapters/community/announcements";
import { D1ChatStore } from "../src/adapters/community/chatStore";
import { acceptMatchClaim } from "../src/flows/matchSave/claims";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { accountFixture } from "./accountFixtures";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";

import { publishedChatTournament } from "./tournamentChatFixtures";

const bindings = env as typeof env & {
  COMMUNITY_BATCHES_TEST_DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const database = bindings.COMMUNITY_BATCHES_TEST_DB;
beforeAll(() => applyD1Migrations(database, bindings.TEST_MIGRATIONS));
const account = () => accountFixture(true, crypto.randomUUID(), database);

function batchFixture() {
  const batches: string[][] = [];

  function prepare(sql: string, statement = database.prepare(sql)) {
    return {
      sql,
      statement,
      bind: (...values: unknown[]) => prepare(sql, statement.bind(...values)),
      all: statement.all.bind(statement),
      first: statement.first.bind(statement),
      run: statement.run.bind(statement),
    };
  }

  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      batches.push(statements.map(({ sql }) => sql));
      return database.batch(statements.map(({ statement }) => statement));
    },
  } as unknown as D1Database;
  return { db, batches };
}

function expectBatch(batches: string[][], first: RegExp, ...rest: RegExp[]) {
  const actual = batches.flatMap((batch) => {
    const statements = batch.map((sql) => sql.replace(/\s+/g, " ").trim());
    return statements.flatMap((sql, index) =>
      first.test(sql) ? [statements.slice(index, index + rest.length + 1)] : [],
    );
  });
  expect(actual).toEqual([[first, ...rest].map((sql) => expect.stringMatching(sql))]);
}

const announcement: AnnouncementInput = {
  title: "更新のお知らせ",
  body: "本文",
  date: "2026-11-07",
  kind: "feature",
  published: true,
  lobbyGames: ["four-reversi"],
};
const eventInsert = /\bINSERT OR IGNORE INTO notification_events\b/i;
const badgeNotificationInsert = /^INSERT INTO account_badge_notifications\b/i;

test("お知らせの作成と通知の INSERT を同じ batch に入れる", async () => {
  const { db, batches } = batchFixture();

  await create(db, announcement);

  expectBatch(batches, /^INSERT INTO announcements\b/i, eventInsert);
});

test("お知らせの公開更新と通知の INSERT を同じ batch に入れる", async () => {
  const { db, batches } = batchFixture();
  const id = await create(db, { ...announcement, published: false });
  batches.length = 0;

  await update(db, id, announcement, 1);

  expectBatch(batches, /^UPDATE announcements\b/i, eventInsert);
});

test("チャットの投稿と送信時刻、再送台帳、件数制限を同じ batch に入れる", async () => {
  const { db, batches } = batchFixture();
  const { id: accountId } = await account();

  const tournamentId = 74204;
  const tournament = await publishedChatTournament(database, tournamentId);
  await tournament.enroll(accountId);

  await new D1ChatStore(db).insertEligiblePost(
    {
      accountId,
      requestId: "fixture-chat-request",
      tournamentId,
      text: "対局募集",
      bodyHash: "fixture-hash",
      sentAtMs: 20_000,
    },
    { lastPostByMs: 10_000, finalizedAfterMs: 0, requestAfterMs: 0 },
  );

  expectBatch(
    batches,
    /^INSERT OR IGNORE INTO lobby_chat_messages\b/i,
    /^UPDATE lobby_chat_senders SET last_sent_at_ms\s*=/i,
    /^INSERT OR IGNORE INTO lobby_chat_requests\b/i,
    /^DELETE FROM lobby_chat_messages\b.*\bOFFSET 500\b/i,
  );
});

test("四人リバーシの対局保存でバッジ台帳と通知の INSERT を同じ batch に入れる", async () => {
  const { db, batches } = batchFixture();
  const { id } = await account();
  for (let i = 0; i < 4; i++) await writeMatch(database, humanFixtureRecord(id, i));

  await writeMatch(db, humanFixtureRecord(id, 4));

  expectBatch(batches, badgeNotificationInsert, eventInsert);
});

test("四人将棋の対局保存でバッジ台帳と通知の INSERT を同じ batch に入れる", async () => {
  const { db, batches } = batchFixture();
  const { id } = await account();

  await saveShogiFixture(humanShogiRecord(id), db);

  expectBatch(batches, badgeNotificationInsert, eventInsert);
});

test("対局の引き継ぎでバッジ台帳と通知の INSERT を同じ batch に入れる", async () => {
  const { db, batches } = batchFixture();
  const { id: accountId } = await account();
  const record = humanFixtureRecord(accountId, 0);
  const player = record.participants.find((participant) => participant.kind === "human");
  if (player?.kind !== "human") throw new Error("Expected a human participant");
  player.accountId = null;
  await writeMatch(db, record);
  batches.length = 0;

  await acceptMatchClaim(db, {
    matchId: record.id,
    roomId: record.roomId,
    instanceId: record.instanceId,
    playerId: player.id,
    accountId,
  });

  expectBatch(batches, badgeNotificationInsert, eventInsert);
});
