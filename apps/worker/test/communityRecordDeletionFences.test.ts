import { markAllNotificationsRead, markNotificationRead } from "@tetraboard/context-community";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, onTestFinished, test, vi } from "vitest";
import { create } from "../src/adapters/community/announcements";
import { badgeEventStatement } from "../src/adapters/community/badgeEvents";
import {
  mergeNotificationStatements,
  notificationRequestStore,
} from "../src/adapters/community/notifications";
import { badgeAwardStatements } from "../src/adapters/record/badgeAwards";
import {
  guestBadgeTransferStatements,
  guestMatchAccountTransferStatements,
} from "../src/adapters/record/guestMergeWrites";
import { D1MatchClaimStore } from "../src/adapters/record/matchClaimStore";
import {
  shogiHistoryStatement,
  snapshotHistoryStatement,
} from "../src/adapters/record/publication";
import { D1TournamentFinalization } from "../src/adapters/tournament/finalization";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { markDeleted } from "./guestFenceFixtures";
import { guestMergeDb as withTriggers, history, testMigrations } from "./guestMergeRecordFixtures";

const withoutTriggers = (env as typeof env & { TB_154_WITHOUT_TRIGGERS_TEST_DB: D1Database })
  .TB_154_WITHOUT_TRIGGERS_TEST_DB;
const triggerNames = [
  "privacy_fence_feedback",
  "notification_reads_privacy",
  "notification_state_privacy",
  "notification_privacy_insert",
  "notification_privacy_update",
  "privacy_fence_account_badge_awards",
  "privacy_fence_account_badge_notifications",
  "privacy_fence_account_match_history",
  "privacy_fence_match_claim_insert",
  "privacy_fence_match_claim_update",
];

beforeAll(async () => {
  await Promise.all(
    [withTriggers, withoutTriggers].map((db) => applyD1Migrations(db, testMigrations)),
  );
  await withoutTriggers.batch(
    triggerNames.map((name) => withoutTriggers.prepare(`DROP TRIGGER ${name}`)),
  );
});

const databases = [
  { name: "トリガーあり", db: withTriggers },
  { name: "トリガーなし", db: withoutTriggers },
];
const account = (db: D1Database) => accountFixture(true, crypto.randomUUID(), db);
const announcement = {
  title: "全体通知",
  body: "本文",
  date: "2026-11-18",
  kind: "feature" as const,
  published: true,
  lobbyGames: [],
};

async function rows(db: D1Database, sql: string, ...values: unknown[]) {
  return (
    await db
      .prepare(sql)
      .bind(...values)
      .all()
  ).results;
}

async function announcementSeq(db: D1Database) {
  const id = await create(db, announcement);
  return (await db
    .prepare(
      "SELECT seq FROM notification_events WHERE kind='announcement' AND source_id=? AND account_id=''",
    )
    .bind(id)
    .first<number>("seq"))!;
}

// 受付の連鎖が通る前の古い行を残し、対象の INSERT / UPDATE だけを検証します。
async function markDeletedWithoutCascade(db: D1Database, id: string) {
  const placeholder = crypto.randomUUID();
  await markDeleted(db, placeholder);
  await db.prepare("UPDATE deleted_accounts SET id=? WHERE id=?").bind(id, placeholder).run();
}

test.each(databases)(
  "$name: 認証後に退会したフィードバックは429で、投稿も予約も作りません",
  async ({ db }) => {
    const user = await account(db);
    const data = new FormData();
    const submissionId = crypto.randomUUID();
    data.set(
      "input",
      JSON.stringify({
        submissionId,
        kind: "opinion",
        game: "four-reversi",
        body: "認証後に退会",
        expectation: "",
        steps: "",
        technical: null,
      }),
    );
    const before = await rows(db, "SELECT * FROM feedback_limits");
    const batch = db.batch.bind(db);
    const race = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await markDeleted(db, user.id);
      return batch(statements);
    });
    onTestFinished(() => race.mockRestore());

    const response = await worker.fetch(
      new Request(origin + "/api/feedback", {
        method: "POST",
        headers: { Cookie: user.cookie, Origin: origin },
        body: data,
      }),
      { ...env, APP_DB: db },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("600");
    expect(await response.json()).toEqual({
      message: "送信が多いため、時間をおいて再試行してください。",
    });
    expect(await rows(db, "SELECT id FROM feedback WHERE submission_id=?", submissionId)).toEqual(
      [],
    );
    expect(await rows(db, "SELECT * FROM feedback_limits")).toEqual(before);
  },
);

test.each(databases)(
  "$name: 退会後の既読操作は成功を返し、既読と初回基準を保存しません",
  async ({ db }) => {
    const id = crypto.randomUUID();
    const seq = await announcementSeq(db);
    await markDeleted(db, id);
    const store = notificationRequestStore(db);

    expect(await markNotificationRead(store, id, seq)).toBe(true);
    expect(await markAllNotificationsRead(store, id, seq)).toBe(true);
    expect(
      await rows(db, "SELECT * FROM account_notification_reads WHERE account_id=?", id),
    ).toEqual([]);
    expect(
      await rows(db, "SELECT * FROM account_notification_state WHERE account_id=?", id),
    ).toEqual([]);
  },
);

test.each(databases)(
  "$name: 通知の付け替えは退会した統合先に宛先と既読を作りません",
  async ({ db }) => {
    const guest = crypto.randomUUID(),
      target = crypto.randomUUID();
    const seq = await announcementSeq(db);
    const store = notificationRequestStore(db);
    await store.initializeReadState(target);
    await store.insertRead(guest, seq);
    await db
      .prepare(
        "INSERT INTO notification_events(kind,source_id,account_id,created_at_ms) VALUES('tournament',?,?,1)",
      )
      .bind(guest, guest)
      .run();
    await markDeleted(db, target);
    const stateBefore = await rows(
      db,
      "SELECT * FROM account_notification_state WHERE account_id=?",
      target,
    );

    await db.batch(mergeNotificationStatements(db, guest, target));

    expect(
      await rows(db, "SELECT account_id FROM notification_events WHERE source_id=?", guest),
    ).toEqual([{ account_id: guest }]);
    expect(
      await rows(db, "SELECT * FROM account_notification_reads WHERE account_id=?", target),
    ).toEqual([]);
    expect(
      await rows(db, "SELECT * FROM account_notification_state WHERE account_id=?", target),
    ).toEqual(stateBefore);
  },
);

test.each(databases)(
  "$name: 通知イベントは退会者の宛先を省き、空の宛先を許可します",
  async ({ db }) => {
    const target = crypto.randomUUID(),
      key = crypto.randomUUID();
    await markDeleted(db, target);
    await markDeleted(db, "");
    onTestFinished(async () => {
      await db.prepare("DELETE FROM deleted_accounts WHERE id=''").run();
    });
    await db
      .prepare(
        "INSERT INTO tournaments(key,name,starts_at_ms,ends_at_ms,created_at_ms,updated_at_ms) VALUES(?,'大会',0,1,0,0)",
      )
      .bind(key)
      .run();
    const adapter = new D1TournamentFinalization(db);
    const payload = { id: 1, name: "大会", rank: 1, tied: false };
    const snapshot = { key, entries: 0 };

    await db.batch(
      [target, ""].map((accountId) =>
        adapter.notification(
          {
            entryId: key + accountId,
            accountId,
            rank: 1,
            username: null,
            name: "参加者",
            avatarUrl: null,
            pointsUnits: 0,
            games: 1,
            first: 1,
            second: 0,
            third: 0,
            fourth: 0,
            knockouts: 0,
            rankSum: 1,
          },
          payload,
          2,
          snapshot,
        ),
      ),
    );

    expect(
      await rows(
        db,
        "SELECT source_id, account_id FROM notification_events WHERE source_id IN (?,?)",
        key,
        key + target,
      ),
    ).toEqual([{ source_id: key, account_id: "" }]);
    expect(await announcementSeq(db)).toBeGreaterThan(0);
  },
);

const badgeAward = (db: D1Database, accountId: string, matchId: string) =>
  db
    .prepare("INSERT INTO account_badge_awards VALUES (?,'four-reversi','games',1,5,0,?)")
    .bind(accountId, matchId);
const badgeToast = (db: D1Database, accountId: string, matchId: string) =>
  db
    .prepare(
      "INSERT INTO account_badge_notifications(account_id,match_id,game,created_at_ms) VALUES (?,?,'four-reversi',0)",
    )
    .bind(accountId, matchId);

test.each(databases)("$name: 退会後に残った獲得記録からバッジ通知を作りません", async ({ db }) => {
  const target = crypto.randomUUID(),
    matchId = crypto.randomUUID();
  await badgeAward(db, target, matchId).run();
  await markDeleted(db, target);

  await db.batch([
    ...badgeAwardStatements(db, "four-reversi", matchId),
    badgeEventStatement(db, matchId),
  ]);

  expect(
    await rows(db, "SELECT * FROM account_badge_notifications WHERE match_id=?", matchId),
  ).toEqual([]);
  expect(await rows(db, "SELECT * FROM notification_events WHERE source_id=?", matchId)).toEqual(
    [],
  );
});

test.each(databases)(
  "$name: 退会者のバッジトーストがイベント生成に届いても本人宛のイベントを作りません",
  async ({ db }) => {
    const target = crypto.randomUUID(),
      matchId = crypto.randomUUID();
    await db.batch([badgeAward(db, target, matchId), badgeToast(db, target, matchId)]);
    await markDeleted(db, target);

    await db.batch([
      db
        .prepare(
          "UPDATE account_badge_notifications SET created_at_ms=(SELECT value FROM notification_metadata WHERE key='started_at_ms') WHERE match_id=?",
        )
        .bind(matchId),
      badgeEventStatement(db, matchId),
    ]);

    expect(await rows(db, "SELECT * FROM notification_events WHERE source_id=?", matchId)).toEqual(
      [],
    );
  },
);

test.each(databases)(
  "$name: バッジの付け替えは退会した統合先に獲得と通知を追加しません",
  async ({ db }) => {
    const guest = crypto.randomUUID(),
      target = crypto.randomUUID(),
      matchId = crypto.randomUUID();
    await db.batch([badgeAward(db, guest, matchId), badgeToast(db, guest, matchId)]);
    await markDeleted(db, target);

    await db.batch(guestBadgeTransferStatements(db, guest, target));

    expect(await rows(db, "SELECT * FROM account_badge_awards WHERE match_id=?", matchId)).toEqual(
      [],
    );
    expect(
      await rows(db, "SELECT * FROM account_badge_notifications WHERE match_id=?", matchId),
    ).toEqual([]);
  },
);

function match(db: D1Database, matchId: string, game: string, mode: string, record: object) {
  return db
    .prepare(
      "INSERT INTO matches (id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES(?,?,?,1,2,?)",
    )
    .bind(matchId, game, mode, JSON.stringify(record));
}

test.each(databases)(
  "$name: バッジ再集計は退会済みの履歴を読んでも獲得を保存しません",
  async ({ db }) => {
    const { id } = await account(db);
    const matchIds = [1, 2, 3, 4, 5].map(() => crypto.randomUUID());
    const participants = ["black", "white", "red", "blue"].map((color, seat) => ({
      color,
      kind: "human",
      accountId: seat === 0 ? id : null,
    }));
    await db.batch(
      matchIds.flatMap((matchId) => [
        match(db, matchId, "four-reversi", "singles", { participants }),
        db
          .prepare("INSERT INTO account_match_history VALUES (?,?,'singles',1,'four-reversi')")
          .bind(id, matchId),
      ]),
    );
    await markDeletedWithoutCascade(db, id);

    await db.batch(badgeAwardStatements(db, "four-reversi", matchIds[4]!));

    expect(await rows(db, "SELECT * FROM account_badge_awards WHERE account_id=?", id)).toEqual([]);
  },
);

const claim = (db: D1Database, matchId: string, accountId: string, state = "pending") =>
  db
    .prepare("INSERT INTO match_participant_accounts VALUES (?,'player',?,'room','instance',?,0,0)")
    .bind(matchId, accountId, state);

test.each(databases)(
  "$name: 公開と引き継ぎの遅延保存は退会した統合先の履歴だけを省きます",
  async ({ db }) => {
    const guest = crypto.randomUUID(),
      target = crypto.randomUUID(),
      survivor = crypto.randomUUID();
    const snapshots = [crypto.randomUUID(), crypto.randomUUID()];
    const claimed = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO guest_account_merges VALUES(?,?,1)").bind(guest, target),
      ...snapshots.map((id) =>
        match(db, id, "shogi", "standard", {
          participants: [guest, survivor].map((accountId) => ({ kind: "human", accountId })),
        }),
      ),
      match(db, claimed, "shogi", "standard", {}),
      claim(db, claimed, guest, "applied"),
    ]);
    await markDeleted(db, target);
    const store = new D1MatchClaimStore(db, () => []);

    await db.batch([
      snapshotHistoryStatement(db, snapshots[0]!),
      shogiHistoryStatement(db, snapshots[1]!),
      store.history(claimed),
    ]);

    for (const id of snapshots)
      expect(await history(db, id)).toEqual([expect.objectContaining({ account_id: survivor })]);
    expect(await history(db, claimed)).toEqual([]);
  },
);

test.each(databases)(
  "$name: 棋譜の移し替えと再試行は退会済みの本人参照を書き込みません",
  async ({ db }) => {
    const guest = crypto.randomUUID(),
      target = crypto.randomUUID();
    const pending = crypto.randomUUID(),
      moving = crypto.randomUUID(),
      accepting = crypto.randomUUID();
    await accountFixture(true, target, db);
    await db.batch([claim(db, pending, target), claim(db, moving, guest)]);
    await markDeletedWithoutCascade(db, target);
    const store = new D1MatchClaimStore(db, () => []);

    await store.accept(
      {
        matchId: accepting,
        accountId: target,
        playerId: "player",
        roomId: "room",
        instanceId: "instance",
      },
      1,
    );
    await store.postponeRetry(pending, 50);
    await db.batch(guestMatchAccountTransferStatements(db, guest, target));

    expect(await store.readAccepted(accepting, "player")).toBeNull();
    expect(await store.readAccepted(pending, "player")).toMatchObject({
      account_id: target,
      state: "pending",
      retry_at_ms: 0,
    });
    expect(await store.readAccepted(moving, "player")).toMatchObject({ account_id: guest });
  },
);
