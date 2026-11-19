import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { avatarPresets, notificationListSchema } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { accountIdentity } from "../src/adapters/account/auth";
import { humanFixtureRecord } from "./matchFixtures";
import { writeMatch } from "../src/flows/matchSave/snapshot";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import worker from "../src/worker";
import { lobbyChatSchema, lobbyPostResultSchema } from "@tetraboard/protocol/general-lobby";
import { cleanupLobbyChat } from "../src/adapters/community/chatCleanup";
import { badgeEventStatement } from "../src/adapters/community/badgeEvents";
import { guest, link, request, trackGuestAccountRooms } from "./guestAccountsFixtures";

const createdRooms = trackGuestAccountRooms();

test("既存アカウントへの統合は認証後の確認まで変更せず、本人だけが全記録を一度引き継ぐ", async () => {
  const g = await guest(),
    record = humanFixtureRecord(g.id, 1);
  await writeMatch(env.APP_DB, record);
  const { target, headers } = await link(g);
  await env.APP_DB.prepare("UPDATE user SET avatarPresetId=? WHERE id=?")
    .bind(avatarPresets[1].id, g.id)
    .run();
  await env.APP_DB.prepare("UPDATE user SET avatarPresetId=? WHERE id=?")
    .bind(avatarPresets[2].id, target.id)
    .run();
  await env.APP_DB.prepare(
    "UPDATE user SET profileMessage='統合先のひとこと', favoriteGames='[\"shogi\"]' WHERE id=?",
  )
    .bind(target.id)
    .run();
  expect(await (await request("/account/guest-merge", { headers })).json()).toEqual({
    pending: { guestName: g.user.name },
  });
  expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: g.headers })).status,
  ).toBe(401);
  const wrong = await accountFixture();
  expect(
    (
      await request("/account/guest-merge", {
        method: "POST",
        headers: { ...wrong.headers, Cookie: `${wrong.cookie}; ${g.cookie}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/account/guest-merge", {
        method: "POST",
        headers: { ...headers, Origin: "https://wrong.test" },
      })
    ).status,
  ).toBe(403);
  expect((await request("/account/guest-merge", { method: "POST", headers })).status).toBe(200);
  expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
  const saved = await env.APP_DB.prepare(
    "SELECT account_id FROM account_match_history WHERE match_id=?",
  )
    .bind(record.id)
    .first<{ account_id: string }>();
  expect(saved!.account_id).toBe(target.id);
  expect(
    await (await request("/account/session", { headers: target.headers })).json(),
  ).toMatchObject({ user: { profileMessage: "統合先のひとこと", favoriteGames: ["shogi"] } });
  expect(
    await env.APP_DB.prepare("SELECT avatarPresetId FROM user WHERE id=?")
      .bind(target.id)
      .first("avatarPresetId"),
  ).toBe(avatarPresets[2].id);
  const stats = await request("/account/stats?game=four-reversi", { headers: target.headers });
  expect(await stats.json()).toMatchObject({ singles: { total: 1 } });
  expect((await request("/account/guest-merge", { method: "POST", headers })).status).toBe(401);
  // 統合前に作られた保存待ちの再送も、統合先へ記録します。
  const late = humanFixtureRecord(g.id, 2);
  await writeMatch(env.APP_DB, late);
  await writeMatch(env.APP_DB, late);
  expect(
    (await env.APP_DB.prepare("SELECT account_id FROM account_match_history WHERE match_id=?")
      .bind(late.id)
      .first<{ account_id: string }>())!.account_id,
  ).toBe(target.id);
  expect(
    await (await request("/account/stats?game=four-reversi", { headers: target.headers })).json(),
  ).toMatchObject({ singles: { total: 2 } });
});

test("ゲスト統合はfeedbackを1回だけ更新し、本人の投稿だけを引き継ぐ", async () => {
  const g = await guest();
  const other = await accountFixture();
  const ownId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  for (const [id, accountId] of [
    [ownId, g.id],
    [otherId, other.id],
  ])
    await env.APP_DB.prepare(`INSERT INTO feedback
      (id,submission_id,payload_hash,author,reporter_hash,internal,kind,game,body,expectation,steps,received_at_ms,expires_at_ms,account_id)
      VALUES(?,?,?,'guest',?,0,'bug','all',?,'','',?,?,?)`)
      .bind(id, id, id, id, "引き継ぐ本文", Date.now(), Date.now() + 86400000, accountId)
      .run();
  try {
    const { target, headers } = await link(g);
    const feedbackUpdates: string[] = [];
    const db = new Proxy(env.APP_DB, {
      get(database, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (/^\s*UPDATE\s+feedback\b/i.test(sql)) feedbackUpdates.push(sql);
            return database.prepare(sql);
          };
        const value = Reflect.get(database, key);
        return typeof value === "function" ? value.bind(database) : value;
      },
    });
    const response = await worker.fetch(
      new AcceptedGameRequest(`${origin}/api/account/guest-merge`, { method: "POST", headers }),
      { ...env, APP_DB: db },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(feedbackUpdates).toHaveLength(1);
    const saved = await env.APP_DB.prepare(
      "SELECT id,account_id,body FROM feedback WHERE id IN (?,?)",
    )
      .bind(ownId, otherId)
      .all();
    expect(saved.results).toHaveLength(2);
    expect(saved.results).toEqual(
      expect.arrayContaining([
        { id: ownId, account_id: target.id, body: "引き継ぐ本文" },
        { id: otherId, account_id: other.id, body: "引き継ぐ本文" },
      ]),
    );
  } finally {
    await env.APP_DB.prepare("DELETE FROM feedback WHERE id IN (?,?)").bind(ownId, otherId).run();
  }
});

test("ゲストの公開チャットは統合後も非表示用ID・再送・投稿停止・通報を保ち、退会で削除する", async () => {
  const g = await guest(),
    other = await accountFixture();
  const post = (headers: HeadersInit, text: string, requestId = crypto.randomUUID()) =>
    request("/lobby/chat", { method: "POST", headers, body: JSON.stringify({ text, requestId }) });
  const report = (headers: HeadersInit, messageId: string) =>
    request("/lobby/chat/reports", {
      method: "POST",
      headers,
      body: JSON.stringify({ messageId }),
    });
  const subject = lobbyPostResultSchema.parse(
    await (await post(other.headers, "通報対象")).json(),
  ).message!;
  const requestId = crypto.randomUUID();
  const before = lobbyPostResultSchema.parse(
    await (await post(g.headers, "元ゲストの投稿", requestId)).json(),
  ).message!;
  expect((await report(g.headers, subject.id)).status).toBe(201);
  let reading!: () => void, releaseReport!: () => void;
  const bodyRead = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const delayedBody = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reading();
        return new Promise<void>((resolve) => {
          let released = false;
          releaseReport = () => {
            if (released) return;
            released = true;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ messageId: subject.id })));
            controller.close();
            resolve();
          };
        });
      },
    },
    { highWaterMark: 0 },
  );
  // 本人確認の後で本文を待たせ、統合より遅れてSQLが実行される要求を再現します。
  const delayedReport = worker.fetch(
    new Request(`${origin}/api/lobby/chat/reports`, {
      method: "POST",
      headers: g.headers,
      body: delayedBody,
    }),
    env,
    {} as ExecutionContext,
  );
  await bodyRead;
  try {
    const linked = await link(g);
    expect((await post(linked.target.headers, "登録者の投稿")).status).toBe(200);
    expect((await report(linked.target.headers, subject.id)).status).toBe(201);
    expect((await report(linked.target.headers, before.id)).status).toBe(201);
    await env.APP_DB.prepare("UPDATE lobby_chat_senders SET stopped=1 WHERE account_id=?")
      .bind(g.id)
      .run();
    expect(
      (await request("/account/guest-merge", { method: "POST", headers: linked.headers })).status,
    ).toBe(200);
    releaseReport();
    expect((await delayedReport).status).toBe(429);
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM lobby_chat_reports WHERE reporter_account_id=?")
        .bind(g.id)
        .first(),
    ).toBeNull();
    const page = lobbyChatSchema.parse(
      await (await request("/lobby/chat", { headers: linked.target.headers })).json(),
    );
    expect(page.messages.find((message) => message.id === before.id)).toMatchObject({
      own: true,
      senderId: before.senderId,
      senderName: "登録名",
    });
    expect(page.postingStopped).toBe(true);
    expect((await post(linked.target.headers, "停止を回避")).status).toBe(403);
    const retry = await post(linked.target.headers, "元ゲストの投稿", requestId);
    expect(retry.status).toBe(200);
    expect(lobbyPostResultSchema.parse(await retry.json()).message?.id).toBe(before.id);
    expect(
      (
        await env.APP_DB.prepare(
          "SELECT id FROM lobby_chat_reports WHERE message_id=? AND reporter_account_id=?",
        )
          .bind(subject.id, linked.target.id)
          .all()
      ).results,
    ).toHaveLength(1);
    const moderation = await worker.fetch(
      new Request(`${origin}/api/admin/lobby-chat`, {
        method: "POST",
        headers: linked.target.headers,
        body: JSON.stringify({ action: "stop", senderId: before.senderId, stopped: false }),
      }),
      { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([linked.target.id]) },
      {} as ExecutionContext,
    );
    expect(moderation.status).toBe(200);
    expect((await post(linked.target.headers, "送信間隔を回避")).status).toBe(429);
    expect(await requestDeletion(env, linked.target.id, crypto.randomUUID())).toBe(true);
    await cleanupLobbyChat(env.APP_DB);
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM lobby_chat_messages WHERE id=?")
        .bind(before.id)
        .first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM lobby_chat_senders WHERE account_id IN (?,?)")
        .bind(g.id, linked.target.id)
        .first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare(
        "SELECT sender_name,sender_public_id FROM lobby_chat_reports WHERE message_id=?",
      )
        .bind(before.id)
        .first(),
    ).toEqual({ sender_name: "退会したプレイヤー", sender_public_id: null });
  } finally {
    releaseReport();
    await delayedReport;
  }
});

test("同じ対局の複数席を統合せず、失敗時に記録と統合確認の資格を残す", async () => {
  const g = await guest();
  const { target, headers } = await link(g);
  const record = humanFixtureRecord(g.id, 1);
  const other = record.participants[1]!;
  if (other.kind !== "human") throw new Error();
  other.accountId = target.id;
  await writeMatch(env.APP_DB, record);
  expect((await request("/account/guest-merge", { method: "POST", headers })).status).toBe(409);
  expect(await accountIdentity(new Request(origin, { headers: g.headers }), env)).toBeNull();
  expect(await (await request("/account/guest-merge", { headers })).json()).toMatchObject({
    pending: { guestName: g.user.name },
  });
  expect(
    await env.APP_DB.prepare("SELECT guest_id FROM guest_account_merges WHERE guest_id=?")
      .bind(g.id)
      .first(),
  ).toBeNull();
});

test("統合した戦績の合計でバッジを判定し、既存の獲得記録を二重作成しない", async () => {
  const g = await guest(),
    linked = await link(g);
  for (let i = 0; i < 4; i++)
    await writeMatch(env.APP_DB, humanFixtureRecord(linked.target.id, i + 1));
  await writeMatch(env.APP_DB, humanFixtureRecord(g.id, 1));
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: linked.headers })).status,
  ).toBe(200);
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS n FROM account_badge_awards WHERE account_id=? AND badge_id='games' AND tier=1",
    )
      .bind(linked.target.id)
      .first(),
  ).toEqual({ n: 1 });
});

test("ゲスト統合で獲得済みバッジが重なっても通知のIDとバッジ一覧を保つ", async () => {
  const db = env.APP_DB;
  const g = await guest();
  const guestMatchId = crypto.randomUUID();
  const targetMatchId = crypto.randomUUID();
  const values = { games: 5, wins: 3 };
  const awardBadges = (accountId: string, matchId: string, badges: (keyof typeof values)[]) =>
    db.batch([
      ...badges.map((badge) =>
        db
          .prepare(`INSERT INTO account_badge_awards
            (account_id,game,badge_id,tier,value,previous_tier,match_id)
            VALUES(?,'four-reversi',?,1,?,0,?)`)
          .bind(accountId, badge, values[badge], matchId),
      ),
      db
        .prepare(`INSERT INTO account_badge_notifications (account_id,match_id,game,created_at_ms)
          SELECT ?,?,'four-reversi',value FROM notification_metadata WHERE key='started_at_ms'`)
        .bind(accountId, matchId),
      badgeEventStatement(db, matchId),
    ]);
  const badgeNotices = async (headers: HeadersInit) => {
    const response = await request("/notifications", { headers });
    expect(response.status).toBe(200);
    return notificationListSchema
      .parse(await response.json())
      .notifications.filter((notification) => notification.kind === "badge");
  };

  await awardBadges(g.id, guestMatchId, ["games", "wins"]);
  const guestNotice = (await badgeNotices(g.headers)).find((n) => n.badge.id === guestMatchId);
  expect(guestNotice?.badge.badges.map((b) => b.id).sort()).toEqual(["games", "wins"]);
  const { target, headers } = await link(g);
  await awardBadges(target.id, targetMatchId, ["wins"]);
  const targetNotice = (await badgeNotices(target.headers)).find(
    (n) => n.badge.id === targetMatchId,
  );
  expect(targetNotice?.badge.badges.map((b) => b.id)).toEqual(["wins"]);

  expect((await request("/account/guest-merge", { method: "POST", headers })).status).toBe(200);

  const merged = await badgeNotices(target.headers);
  expect(merged.find((n) => n.badge.id === guestMatchId)).toEqual(guestNotice);
  expect(merged.find((n) => n.badge.id === targetMatchId)).toEqual(targetNotice);
});

test("統合後の退会で、元ゲストの保存待ち・遅延した棋譜からも名前と本人参照を除去する", async () => {
  const g = await guest(),
    linked = await link(g),
    roomId = `guest-privacy-${crypto.randomUUID()}`;
  createdRooms.add(roomId);
  const stub = env.GAME_ROOM.getByName(roomId),
    record = humanFixtureRecord(g.id, 1);
  await runInDurableObject(stub, (_instance, ctx) => {
    ctx.storage.kv.put("guest-record-fixture", { record });
  });
  await env.APP_DB.prepare("INSERT INTO privacy_room_accounts VALUES(?,?)")
    .bind(g.id, roomId)
    .run();
  expect(
    (await request("/account/guest-merge", { method: "POST", headers: linked.headers })).status,
  ).toBe(200);
  expect(await requestDeletion(env, linked.target.id, crypto.randomUUID())).toBe(true);
  await stub.purgeAccount(linked.target.id);
  const pending = await runInDurableObject(stub, (_instance, ctx) =>
    ctx.storage.kv.get<{ record: typeof record }>("guest-record-fixture"),
  );
  expect(pending!.record.participants[0]).toMatchObject({
    accountId: null,
    name: "退会したプレイヤー",
    retired: true,
  });
  await env.APP_DB.prepare("DELETE FROM user WHERE id=?").bind(linked.target.id).run();
  const late = humanFixtureRecord(g.id, 2);
  await writeMatch(env.APP_DB, late);
  const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(late.id)
    .first<{ record_json: string }>();
  expect(JSON.parse(row!.record_json).participants[0]).toMatchObject({
    accountId: null,
    name: "退会したプレイヤー",
    retired: true,
  });
});
