import { accountIdentity } from "../src/accounts/auth";
import { mergeGuestAccounts, rememberGuestLink } from "../src/accounts/guestLinking";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, expect, test } from "vitest";
import { notificationListSchema, notificationSchema } from "@tetraboard/protocol";
import worker from "../src/worker";
import { accountFixture as baseAccountFixture, origin } from "./accountFixtures";
import { create, update } from "../src/announcements/store";
import { finalizeTournament } from "../src/tournaments/store";
import {
  initializeNotifications,
  mergeNotificationStatements,
  hasUnreadNotifications,
  readNotifications,
} from "../src/notifications/store";
import { writeMatch } from "../src/rooms/matchStore";
import { humanFixtureRecord } from "./matchFixtures";
import { requestDeletion, processDeletions } from "../src/privacy/deletion";

const db = (env as typeof env & { NOTIFICATION_TEST_DB: D1Database }).NOTIFICATION_TEST_DB;
const bindings = { ...env, APP_DB: db };
const accountFixture = () => baseAccountFixture(true, crypto.randomUUID(), db);
beforeAll(async () => {
  const migrations = (
    env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }
  ).TEST_MIGRATIONS;
  await applyD1Migrations(db, migrations);
});
type Account = Pick<Awaited<ReturnType<typeof accountFixture>>, "id" | "headers">;
const context = {} as ExecutionContext;
const fetchApi = (path: string, user?: Account, body?: unknown) =>
  worker.fetch(
    new Request(origin + "/api/" + path, {
      ...(user ? { headers: user.headers } : {}),
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    }),
    bindings,
    context,
  );
const input = (published = true) => ({
  title: "更新のお知らせ",
  body: "一行目\n二行目",
  date: "2026-11-07",
  kind: "feature" as const,
  published,
  lobbyGames: [],
});
async function page(user?: Account, query = "") {
  const response = await fetchApi("notifications" + query, user);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return notificationListSchema.parse(await response.json());
}
async function personal(user: Account, source = crypto.randomUUID()) {
  const row = await db
    .prepare(`INSERT INTO notification_events(kind,source_id,account_id,created_at_ms,payload_json)
    VALUES('tournament',?,?,?,?) RETURNING seq`)
    .bind(
      source,
      user.id,
      Date.now(),
      JSON.stringify({ id: 1, name: "本人の大会", rank: 1, tied: false }),
    )
    .first<{ seq: number }>();
  return row?.seq;
}
afterEach(async () => {
  await db.exec("DROP TRIGGER IF EXISTS fail_notification_test");
});

test("初回基準は全体だけを既読にし、公開・編集・再公開・非公開化を追跡する", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  const old = await create(db, input()),
    own = await personal(user),
    secret = await personal(other);
  const initial = await page(user);
  expect(
    initial.notifications.find((n) => n.kind === "announcement" && n.announcement.id === old)?.read,
  ).toBe(true);
  expect(initial.notifications.find((n) => n.id === own)?.read).toBe(false);
  expect(initial.notifications.some((n) => n.id === secret)).toBe(false);
  const fresh = await create(db, input(false));
  expect(await update(db, fresh, input(), 1)).toBe(true);
  const first = (await page(user)).notifications.find(
    (n) => n.kind === "announcement" && n.announcement.id === fresh,
  )!;
  expect(first.read).toBe(false);
  expect(await update(db, fresh, { ...input(), title: "修正", date: "2020-01-01" }, 2)).toBe(true);
  const edited = (await page(user)).notifications.find((n) => n.id === first.id)!;
  expect(edited.kind === "announcement" && edited.announcement.title).toBe("修正");
  expect(await update(db, fresh, input(false), 3)).toBe(true);
  expect((await page(user)).notifications.some((n) => n.id === first.id)).toBe(false);
  expect((await fetchApi(`notifications/${first.id}`, user)).status).toBe(404);
  await update(db, fresh, input(), 4);
  expect(
    (await page(user)).notifications
      .filter((n) => n.kind === "announcement" && n.announcement.id === fresh)
      .map((n) => n.id),
  ).toEqual([first.id]);
  expect((await page()).notifications.every((n) => n.kind === "announcement")).toBe(true);
});

test("本人限定・Origin・入力と再送、既読共有、ページ境界・新着とまとめて既読を確認する", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  await page(user);
  const ids = [];
  for (let i = 0; i < 23; i++) ids.push(await personal(user));
  const first = await page(user);
  expect(first.notifications.length).toBe(20);
  expect(first.nextCursor).not.toBeNull();
  const second = await page(user, `?cursor=${first.nextCursor}`);
  expect(second.notifications.filter((n) => n.kind === "tournament").length).toBe(3);
  expect(new Set([...first.notifications, ...second.notifications].map((n) => n.id)).size).toBe(
    first.notifications.length + second.notifications.length,
  );
  const newId = await personal(user);
  expect(
    (await fetchApi("account/notifications/read-all", user, { through: first.upperBound })).status,
  ).toBe(200);
  const after = await page(user);
  expect(after.notifications.find((n) => n.id === newId)?.read).toBe(false);
  expect(after.notifications.filter((n) => n.id <= first.upperBound).every((n) => n.read)).toBe(
    true,
  );
  for (let i = 0; i < 2; i++)
    expect((await fetchApi("account/notifications/read", user, { id: newId })).status).toBe(200);
  expect(await (await fetchApi("account/notifications/unread", user)).json()).toMatchObject({
    hasUnread: false,
  });
  expect((await fetchApi(`notifications/${newId}`, other)).status).toBe(404);
  expect((await fetchApi("account/notifications/read", other, { id: newId })).status).toBe(404);
  expect((await fetchApi("account/notifications/unread")).status).toBe(401);
  const bad = await worker.fetch(
    new Request(origin + "/api/account/notifications/read", {
      method: "POST",
      headers: { ...user.headers, Origin: "https://other.test" },
      body: JSON.stringify({ id: newId }),
    }),
    bindings,
    context,
  );
  expect(bad.status).toBe(403);
  expect((await fetchApi("account/notifications/read", user, { id: -1 })).status).toBe(400);
  expect(
    (await fetchApi("account/notifications/read-all", user, { through: 999999999 })).status,
  ).toBe(400);
  expect((await fetchApi("notifications?cursor=bad", user)).status).toBe(400);
});

test("全体公開と通知の保存失敗はまとめてロールバックする", async () => {
  await db.exec(
    "CREATE TRIGGER fail_notification_test BEFORE INSERT ON notification_events BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  await expect(create(db, { ...input(), title: "保存失敗の公開記事" })).rejects.toThrow();
  expect(
    await db.prepare("SELECT 1 FROM announcements WHERE title='保存失敗の公開記事'").first(),
  ).toBeNull();
});

test("実際の対局保存からバッジを生成し、toast表示済みとは独立して既読を管理する", async () => {
  const user = await accountFixture();
  for (let i = 0; i < 5; i++) await writeMatch(db, humanFixtureRecord(user.id, i));
  const notifications = (await page(user)).notifications.filter((n) => n.kind === "badge");
  expect(notifications.length).toBeGreaterThan(0);
  const notification = notifications[0]!;
  expect(notification.read).toBe(false);
  if (notification.kind !== "badge") throw new Error("Expected badge");
  expect(notification.badge.badges.some((b) => b.id === "games" && b.tier === 1)).toBe(true);
  await db
    .prepare("UPDATE account_badge_notifications SET shown_at_ms=? WHERE account_id=?")
    .bind(Date.now(), user.id)
    .run();
  expect(
    notificationSchema.parse(
      await (await fetchApi(`notifications/${notification.id}`, user)).json(),
    ).read,
  ).toBe(false);
  await writeMatch(db, humanFixtureRecord(user.id, 4));
  expect((await page(user)).notifications.filter((n) => n.kind === "badge").length).toBe(
    notifications.length,
  );
});

async function tournament(points: number[]) {
  const key = crypto.randomUUID(),
    now = Date.now();
  await db
    .prepare(`INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,created_at_ms,updated_at_ms)
    VALUES(?,(SELECT COALESCE(MAX(public_id),0)+1 FROM tournaments),'表彰通知大会',?,?,1,?,?)`)
    .bind(key, now - 10000, now - 1, now, now)
    .run();
  const users = [];
  for (const point of points) {
    const user = await accountFixture(),
      entry = crypto.randomUUID();
    users.push(user);
    await db.batch([
      db.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(entry, key, user.id, now),
      db
        .prepare(
          "INSERT INTO tournament_scores(entry_id,tournament_key,points_units,games,knockouts,rank_sum) VALUES(?,?,?,1,0,1)",
        )
        .bind(entry, key, point),
    ]);
  }
  return { key, users };
}
test("大会の結果確定に限り同率を含む表彰を生成し、失敗・再実行も原子的に扱う", async () => {
  for (const points of [
    [10, 8, 8, 1],
    [10, 10, 8, 1],
    [0, 0, 0, 0],
  ]) {
    const { key, users } = await tournament(points);
    if (points.every((p) => p === 0))
      await db
        .prepare("UPDATE tournament_scores SET games=0 WHERE tournament_key=?")
        .bind(key)
        .run();
    expect((await page(users[0])).notifications.some((n) => n.kind === "tournament")).toBe(false);
    await finalizeTournament(db, key);
    await finalizeTournament(db, key);
    for (let i = 0; i < users.length; i++) {
      const values = (await page(users[i])).notifications.filter((n) => n.kind === "tournament");
      const expected = points.every((p) => p === 0)
        ? 0
        : points[0] === points[1]
          ? i < 2
            ? 1
            : 0
          : i < 3
            ? 1
            : 0;
      expect(values.length).toBe(expected);
      if (expected)
        expect(values[0]!.kind === "tournament" && values[0]!.tournament.rank).toBe(
          i === 0 || points[0] === points[1] ? 1 : 2,
        );
    }
  }
  const { key } = await tournament([10, 8]);
  await db.exec(
    "CREATE TRIGGER fail_notification_test BEFORE INSERT ON notification_events WHEN NEW.kind='tournament' BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  await expect(finalizeTournament(db, key)).rejects.toThrow();
  expect(
    await db.prepare("SELECT finalized_at_ms FROM tournaments WHERE key=?").bind(key).first(),
  ).toEqual({ finalized_at_ms: null });
  expect(
    (
      await db
        .prepare("SELECT final_rank FROM tournament_scores WHERE tournament_key=?")
        .bind(key)
        .all()
    ).results.every((r) => r.final_rank === null),
  ).toBe(true);
});

test("統合前の個別既読とまとめて既読を保持し、未読を維持して宛先を移す", async () => {
  const guest = await accountFixture(),
    target = await accountFixture();
  await initializeNotifications(db, guest.id);
  await initializeNotifications(db, target.id);
  const guestRead = await personal(guest),
    targetRead = await personal(target);
  await fetchApi("account/notifications/read-all", guest, { through: guestRead });
  await fetchApi("account/notifications/read-all", target, { through: targetRead });
  const unread = await personal(guest);
  await db.batch(mergeNotificationStatements(db, guest.id, target.id));
  const result = await page(target);
  expect(result.notifications.find((n) => n.id === guestRead)?.read).toBe(true);
  expect(result.notifications.find((n) => n.id === targetRead)?.read).toBe(true);
  expect(result.notifications.find((n) => n.id === unread)?.read).toBe(false);
  expect((await page(guest)).notifications.some((n) => n.id === unread)).toBe(false);
});

test("退会受付直後は取得できず、削除と遅延保存のフェンスを維持する", async () => {
  const user = await accountFixture();
  await page(user);
  const id = await personal(user);
  await fetchApi("account/notifications/read", user, { id });
  await requestDeletion(bindings, user.id, "notification-test-receipt");
  // 認証後に退会受付が競合した取得でも、DBの読み取り時点で本人宛を除外します。
  expect(await readNotifications(db, user.id, { id })).toEqual([]);
  expect((await fetchApi(`notifications/${id}`, user)).status).toBe(404);
  const ignored = await personal(user);
  expect(ignored).toBeUndefined();
  await processDeletions(bindings);
  expect(
    await db.prepare("SELECT 1 FROM notification_events WHERE account_id=?").bind(user.id).first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT 1 FROM account_notification_reads WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toBeNull();
});

test("既存公開記事だけを導入時に既読相当とし、過去のバッジは追加生成しない", async () => {
  const isolated = (env as typeof env & { NOTIFICATION_MIGRATION_TEST_DB: D1Database })
    .NOTIFICATION_MIGRATION_TEST_DB;
  const migrations = (
    env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }
  ).TEST_MIGRATIONS;
  await applyD1Migrations(
    isolated,
    migrations.filter((m) => m.name < "0029"),
  );
  const user = await baseAccountFixture(true, crypto.randomUUID(), isolated);
  const published = await create(isolated, input()),
    draft = await create(isolated, input(false));
  await isolated
    .prepare("INSERT INTO account_badge_notifications VALUES(?,?,?,?,NULL,NULL,NULL)")
    .bind(user.id, "past-match", "four-reversi", 1)
    .run();
  await applyD1Migrations(isolated, migrations);
  expect(
    (
      await isolated
        .prepare(
          "SELECT source_id,legacy FROM notification_events WHERE kind='announcement' AND source_id IN (?,?)",
        )
        .bind(published, draft)
        .all()
    ).results,
  ).toEqual([{ source_id: published, legacy: 1 }]);
  expect(
    await isolated.prepare("SELECT 1 FROM notification_events WHERE kind='badge'").first(),
  ).toBeNull();
  expect(await hasUnreadNotifications(isolated, user.id)).toBe(false);
});

test("ゲストCookieの本人も個別通知を既読にでき、既存アカウントへの実統合で引き継ぐ", async () => {
  const response = await worker.fetch(
    new Request(origin + "/api/account/guest", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Legal-Consent": legalVersion,
      },
      body: JSON.stringify({ name: "通知ゲスト" }),
    }),
    bindings,
    context,
  );
  expect(response.status).toBe(201);
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
  const identity = (await accountIdentity(new Request(origin, { headers }), bindings))!;
  const guest = { id: identity.id, headers };
  const seen = await personal(guest),
    unread = await personal(guest);
  expect((await fetchApi("account/notifications/read", guest, { id: seen })).status).toBe(200);
  const target = await accountFixture();
  const state = crypto.randomUUID();
  const session = (await db
    .prepare("SELECT id FROM session WHERE userId=?")
    .bind(target.id)
    .first<{ id: string }>())!;
  await rememberGuestLink(new Request(origin, { headers }), bindings, identity, state, "google");
  await db
    .prepare(
      "UPDATE guest_oauth_flows SET target_id=?,target_session_id=?,is_new_target=0 WHERE state=?",
    )
    .bind(target.id, session.id, state)
    .run();
  await mergeGuestAccounts(bindings, {
    state,
    guest_id: guest.id,
    target_id: target.id,
    target_session_id: session.id,
    name: "通知ゲスト",
    is_new_target: 0,
  });
  const transferred = await page(target);
  expect(transferred.notifications.find((n) => n.id === seen)?.read).toBe(true);
  expect(transferred.notifications.find((n) => n.id === unread)?.read).toBe(false);
  expect((await fetchApi(`notifications/${unread}`, guest)).status).toBe(404);
});

test("統合時の重複通知は既読を優先し、初回基準未作成なら全体だけを基準にする", async () => {
  const source = crypto.randomUUID(),
    guest = await accountFixture(),
    target = await accountFixture();
  const readId = await personal(guest, source),
    targetId = await personal(target, source);
  await fetchApi("account/notifications/read", guest, { id: readId });
  await db.batch(mergeNotificationStatements(db, guest.id, target.id));
  expect((await page(target)).notifications.find((n) => n.id === targetId)?.read).toBe(true);
  expect(
    await db.prepare("SELECT 1 FROM notification_events WHERE seq=?").bind(readId).first(),
  ).toBeNull();
  const freshGuest = await accountFixture(),
    freshTarget = await accountFixture();
  const article = await create(db, input()),
    own = await personal(freshGuest);
  await db.batch(mergeNotificationStatements(db, freshGuest.id, freshTarget.id));
  const initial = await page(freshTarget);
  expect(
    initial.notifications.find((n) => n.kind === "announcement" && n.announcement.id === article)
      ?.read,
  ).toBe(true);
  expect(initial.notifications.find((n) => n.id === own)?.read).toBe(false);
});
