import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { postChatMessage } from "@tetraboard/context-community";
import { announcementStore, create, update } from "../src/adapters/community/announcements";
import { D1ChatStore } from "../src/adapters/community/chatStore";
import { readNotifications } from "../src/adapters/community/notifications";
import { mergeGuestAccounts } from "../src/flows/guestRegistration/guestLink";
import { acceptMatchClaim } from "../src/flows/matchSave/claims";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { accountFixture } from "./accountFixtures";
import { fixTestTime } from "./fixedTimeFixture";
import { humanFixtureRecord } from "./matchFixtures";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { guestFenceFixture, markDeleted } from "./guestFenceFixtures";

const bindings = env as typeof env & {
  COMMUNITY_BATCHES_TEST_DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = bindings.COMMUNITY_BATCHES_TEST_DB;
const fixture = () => accountFixture(true, crypto.randomUUID(), db);
let now: number;

beforeAll(async () => {
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  now = (await db
    .prepare("SELECT value FROM notification_metadata WHERE key='started_at_ms'")
    .first<number>("value"))!;
});

const chat = new D1ChatStore(db);
const post = (
  accountId: string,
  requestId: string,
  sentAtMs: number,
  tournamentId: number | null = null,
) =>
  postChatMessage(
    chat,
    { accountId, requestId, tournamentId, text: "対局募集" },
    () => sentAtMs,
    async (text) => `hash:${text}`,
  );

test("チャットの送信時刻と再送記録を保存し、同時送信にも10秒制限を適用する", async () => {
  const { id } = await fixture();
  const firstId = crypto.randomUUID();
  const accepted = await post(id, firstId, now);
  expect(accepted).toMatchObject({ status: "accepted", message: { sentAtMs: now } });
  expect(
    await db
      .prepare("SELECT last_sent_at_ms FROM lobby_chat_senders WHERE account_id=?")
      .bind(id)
      .first(),
  ).toEqual({ last_sent_at_ms: now });

  const retry = await post(id, firstId, now + 1);
  expect(retry).toEqual(accepted);
  expect((await post(id, crypto.randomUUID(), now + 9999)).status).toBe("rateLimited");
  const concurrent = await Promise.all([
    post(id, crypto.randomUUID(), now + 10_000),
    post(id, crypto.randomUUID(), now + 10_000),
  ]);
  expect(concurrent.map(({ status }) => status).sort()).toEqual(["accepted", "rateLimited"]);
  const requests = await db
    .prepare(
      "SELECT request_id, message_id, body_hash, sent_at_ms FROM lobby_chat_requests WHERE account_id=? ORDER BY sent_at_ms",
    )
    .bind(id)
    .all();
  expect(requests.results).toEqual([
    {
      request_id: firstId,
      message_id: accepted.status === "accepted" ? accepted.message?.id : undefined,
      body_hash: "hash:対局募集",
      sent_at_ms: now,
    },
    {
      request_id: expect.any(String),
      message_id: expect.any(String),
      body_hash: "hash:対局募集",
      sent_at_ms: now + 10_000,
    },
  ]);
});

test("投稿先の大会だけを最新500件にする", async () => {
  const { id } = await fixture();
  const key = crypto.randomUUID();
  const tournamentId = 1;
  const outside = await post(id, crypto.randomUUID(), now - 10_000);
  expect(outside.status).toBe("accepted");
  await db.batch([
    db
      .prepare(`INSERT INTO tournaments(key, public_id, name, starts_at_ms, ends_at_ms, published, created_at_ms, updated_at_ms)
      VALUES(?, ?, '大会', ?, ?, 1, ?, ?)`)
      .bind(key, tournamentId, now, now + 60_000, now, now),
    db
      .prepare(
        "INSERT INTO tournament_entries(id,tournament_key,account_id,entered_at_ms) VALUES(?,?,?,?)",
      )
      .bind(crypto.randomUUID(), key, id, now),
    db
      .prepare(`WITH RECURSIVE numbers(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM numbers WHERE i<500)
      INSERT INTO lobby_chat_messages(id, account_id, body, request_id, body_hash, sent_at_ms, tournament_id)
      SELECT printf('old-%03d',i), ?, '以前の投稿', printf('old-%03d',i), 'old-hash', ?, ? FROM numbers`)
      .bind(id, now - 1, tournamentId),
  ]);

  const requestId = crypto.randomUUID();
  expect((await post(id, requestId, now, tournamentId)).status).toBe("accepted");
  const messages = await db
    .prepare(
      "SELECT id, request_id FROM lobby_chat_messages WHERE tournament_id=? ORDER BY sent_at_ms DESC,id DESC",
    )
    .bind(tournamentId)
    .all();
  expect(messages.results).toHaveLength(500);
  expect(messages.results[0]).toMatchObject({ request_id: requestId });
  expect(messages.results.at(-1)).toMatchObject({ id: "old-002" });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM lobby_chat_messages WHERE account_id=? AND tournament_id IS NULL",
      )
      .bind(id)
      .first(),
  ).toEqual({ count: 1 });
});

const announcement = {
  title: "更新のお知らせ",
  body: "本文",
  date: "2026-11-07",
  kind: "feature" as const,
  published: true,
  lobbyGames: [],
};
const announcementEvents = async (id: string) =>
  (
    await db
      .prepare("SELECT seq,kind,source_id,created_at_ms FROM notification_events WHERE source_id=?")
      .bind(id)
      .all()
  ).results;

test("記事の作成時と公開時に通知し、公開中の更新と非公開では通知を増やさない", async () => {
  const clock = fixTestTime(now);
  const published = await create(db, announcement);
  expect(await announcementEvents(published)).toEqual([
    { seq: expect.any(Number), kind: "announcement", source_id: published, created_at_ms: now },
  ]);
  const draft = await create(db, { ...announcement, published: false });
  expect(await announcementEvents(draft)).toEqual([]);

  clock.mockReturnValue(now + 1);
  expect(await update(db, draft, announcement, 1)).toBe(true);
  const events = await announcementEvents(draft);
  expect(events).toEqual([
    { seq: expect.any(Number), kind: "announcement", source_id: draft, created_at_ms: now + 1 },
  ]);
  clock.mockReturnValue(now + 2);
  expect(await update(db, draft, { ...announcement, title: "編集後" }, 2)).toBe(true);
  expect(await update(db, draft, { ...announcement, published: false }, 3)).toBe(true);
  expect(await announcementEvents(draft)).toEqual(events);
});

test("公開日列で記事を表示・整列し、編集で旧日付列を書き換えない", async () => {
  const store = announcementStore(db);
  const migrated = crypto.randomUUID();
  const newest = await create(db, {
    ...announcement,
    date: "2091-01-01",
    lobbyGames: ["four-reversi"],
  });
  const oldest = await create(db, {
    ...announcement,
    date: "2089-01-01",
    lobbyGames: ["four-reversi"],
  });
  expect(
    await db.prepare("SELECT date,published_on FROM announcements WHERE id=?").bind(newest).first(),
  ).toEqual({ date: null, published_on: "2091-01-01" });
  await db.batch([
    db
      .prepare(`INSERT INTO announcements(id,title,body,date,published_on,kind,published,created_at_ms,updated_at_ms)
      VALUES(?, '移行済みの記事', '本文', '2090-01-01', '2090-01-01', 'other', 1, ?, ?)`)
      .bind(migrated, now, now),
    db
      .prepare(
        "INSERT INTO announcement_lobby_targets(announcement_id, game) VALUES(?, 'four-reversi')",
      )
      .bind(migrated),
    db.prepare("UPDATE announcements SET date='2080-01-01' WHERE id=?").bind(newest),
  ]);

  for (const onlyPublished of [true, false]) {
    const first = await store.list(onlyPublished, undefined, 2);
    expect(first.map((row) => store.record(row).id)).toEqual([newest, migrated]);
    const next = await store.list(onlyPublished, store.position(first[1]!), 1);
    expect(next.map((row) => store.record(row).id)).toEqual([oldest]);
  }
  expect(store.record((await store.latestPublishedForLobby("four-reversi"))!)).toMatchObject({
    id: newest,
    date: "2091-01-01",
  });
  expect(store.record((await store.read(migrated, true))!).date).toBe("2090-01-01");
  expect((await readNotifications(db, "", { announcementId: newest }))[0]).toMatchObject({
    announcement: { date: "2091-01-01" },
  });

  // 通知がない既存の公開行に対する競合更新でも、通知を生成しません。
  expect(await update(db, migrated, announcement, 0)).toBe(false);
  expect(await announcementEvents(migrated)).toEqual([]);
  expect(await update(db, migrated, { ...announcement, date: "2092-01-01" }, 1)).toBe(true);
  expect(
    await db
      .prepare("SELECT date,published_on FROM announcements WHERE id=?")
      .bind(migrated)
      .first(),
  ).toEqual({ date: "2090-01-01", published_on: "2092-01-01" });
  expect(store.record((await store.read(migrated, true))!).date).toBe("2092-01-01");
});

type BadgeEvent = { seq: number; account_id: string; created_at_ms: number; payload_json: string };
const badgeEvents = async (matchId: string) =>
  (
    await db
      .prepare(
        "SELECT seq,account_id,created_at_ms,payload_json FROM notification_events WHERE kind='badge' AND source_id=? ORDER BY seq",
      )
      .bind(matchId)
      .all<BadgeEvent>()
  ).results;

test.each(["four-reversi", "four-shogi"] as const)(
  "%s のバッジ獲得を保存し、再送は同じ通知を維持する",
  async (game) => {
    const clock = fixTestTime(now);
    const { id } = await fixture();
    const matches = Array.from({ length: 5 }, (_, i) => {
      if (game === "four-reversi") {
        const record = humanFixtureRecord(id, i);
        return { id: record.id, save: () => writeMatch(db, record) };
      }
      const match = humanShogiRecord(id);
      return { id: match.record.id, save: () => saveShogiFixture(match, db) };
    });
    for (const match of matches) await match.save();
    const fifth = matches[4]!;
    const events = await badgeEvents(fifth.id);
    expect(events).toEqual([
      {
        seq: expect.any(Number),
        account_id: id,
        created_at_ms: now,
        payload_json: expect.any(String),
      },
    ]);
    expect(JSON.parse(events[0]!.payload_json)).toEqual({
      id: fifth.id,
      game,
      badges: [{ id: "games", tier: 1, previousTier: 0, value: 5 }],
    });
    clock.mockReturnValue(now + 1);
    await fifth.save();
    expect(await badgeEvents(fifth.id)).toEqual(events);
  },
);

const toastFor = (accountId: string, matchId: string) =>
  db
    .prepare(
      "SELECT created_at_ms FROM account_badge_notifications WHERE account_id=? AND match_id=?",
    )
    .bind(accountId, matchId)
    .first();

test("通知開始前のバッジはトーストだけ保存し、開始後の保存再送でもベル通知を補完しない", async () => {
  const clock = fixTestTime(now - 1);
  const { id } = await fixture();
  const matches = Array.from({ length: 5 }, (_, i) => humanFixtureRecord(id, i));
  for (const match of matches) await writeMatch(db, match);
  const latest = matches[4]!;
  expect(await toastFor(id, latest.id)).toEqual({ created_at_ms: now - 1 });

  clock.mockReturnValue(now);
  await writeMatch(db, latest);
  expect(await badgeEvents(latest.id)).toEqual([]);
});

test("退会受付後に届いた対局保存は閾値に達してもトーストとベル通知を作らない", async () => {
  fixTestTime(now);
  const { id } = await fixture();
  for (let i = 0; i < 4; i++) await writeMatch(db, humanFixtureRecord(id, i));
  await markDeleted(db, id);

  const last = humanFixtureRecord(id, 4);
  await writeMatch(db, last);
  expect(await toastFor(id, last.id)).toBeNull();
  expect(await badgeEvents(last.id)).toEqual([]);
});

test("保存済みの対局を引き継ぎ、獲得したバッジの通知を作る", async () => {
  fixTestTime(now);
  const { id } = await fixture();
  for (let i = 0; i < 4; i++) await writeMatch(db, humanFixtureRecord(id, i));
  const last = humanFixtureRecord(id, 4);
  const player = last.participants.find((p) => p.kind === "human" && p.accountId === id);
  if (player?.kind !== "human") throw new Error("Missing match participant");
  player.accountId = null;
  await writeMatch(db, last);

  expect(
    await acceptMatchClaim(db, {
      matchId: last.id,
      roomId: last.roomId,
      instanceId: last.instanceId,
      playerId: player.id,
      accountId: id,
    }),
  ).toBe("applied");
  expect(await badgeEvents(last.id)).toEqual([
    {
      seq: expect.any(Number),
      account_id: id,
      created_at_ms: now,
      payload_json: expect.any(String),
    },
  ]);
});

test("ゲスト統合は通知と既読を付け替え、新規通知を作らない", async () => {
  fixTestTime(now);
  const { guest, target, flow } = await guestFenceFixture(db);
  const matches = Array.from({ length: 5 }, (_, i) => humanFixtureRecord(guest.id, i));
  for (const match of matches) await writeMatch(db, match);
  const { id } = matches[4]!;
  const events = await badgeEvents(id);
  expect(events).toHaveLength(1);
  await db
    .prepare("INSERT INTO account_notification_reads(account_id,notification_seq) VALUES(?,?)")
    .bind(guest.id, events[0]!.seq)
    .run();

  await mergeGuestAccounts({ ...env, APP_DB: db }, flow);

  expect(await badgeEvents(id)).toEqual([{ ...events[0], account_id: target.id }]);
  expect(await toastFor(guest.id, id)).toBeNull();
  expect(await toastFor(target.id, id)).toEqual({ created_at_ms: now });
  expect((await readNotifications(db, target.id, { id: events[0]!.seq }))[0]).toMatchObject({
    read: true,
  });
});
