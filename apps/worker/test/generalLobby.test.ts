import { humanFixtureRecord, fixtureRecord } from "./matchFixtures";
import { writeMatch } from "../src/rooms/matchStore";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { readAnalytics, japanDay } from "../src/admin/metrics";
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, afterEach, expect, test } from "vitest";
import worker from "../src/worker";
import {
  lobbyChatSchema,
  lobbyRoomsSchema,
  lobbyAdminSchema,
} from "@tetraboard/protocol/general-lobby";
import { accountFixture, origin } from "./accountFixtures";
import { cleanupLobbyChat, lobbyRetentionMs } from "../src/lobby/chatStore";
import { requestDeletion, processDeletions } from "../src/privacy/deletion";
import { writeRoomIndex } from "../src/rooms/roomIndex";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountProfileSchema } from "@tetraboard/protocol";
const db = (env as typeof env & { LOBBY_TEST_DB: D1Database }).LOBBY_TEST_DB;
beforeAll(async () => {
  await applyD1Migrations(
    db,
    (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
});
afterEach(async () => {
  await db.batch(
    [
      "analytics_dwell",
      "analytics_pageviews",
      "analytics_participants",
      "analytics_matches",
      "analytics_daily",
      "analytics_metadata",
      "account_match_history",
      "matches",
      "shogi_match_chunks",
      "shogi_match_uploads",
      "lobby_chat_reports",
      "lobby_chat_messages",
      "lobby_chat_requests",
      "lobby_chat_senders",
      "session",
      "account",
      "legal_consents",
      "user",
      "deleted_accounts",
      "deletion_rooms",
      "room_index",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  await db.prepare("UPDATE lobby_chat_settings SET accepting=1").run();
});
const request = (path: string, init?: RequestInit, owner?: string) =>
  worker.fetch(
    new Request(`${origin}/api${path}`, init),
    { ...env, APP_DB: db, ADMIN_ACCOUNT_IDS: owner ? JSON.stringify([owner]) : "[]" },
    {} as ExecutionContext,
  );
async function fixture(complete = true) {
  return accountFixture(complete, crypto.randomUUID(), db);
}
async function guestFixture() {
  const response = await request("/account/guest", {
    method: "POST",
    headers: { Origin: origin, "X-Legal-Consent": legalVersion },
    body: JSON.stringify({ name: "ゲスト投稿者" }),
  });
  expect(response.status).toBe(201);
  const user = accountProfileSchema.parse(await response.json());
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const row = await db
    .prepare("SELECT id FROM user WHERE publicProfileId=?")
    .bind(user.profileId)
    .first<{ id: string }>();
  return { id: row!.id, headers: { Cookie: cookie, Origin: origin } };
}
type ChatUser = { id: string; headers: { Cookie: string; Origin: string } };
async function post(user: ChatUser, text = "募集しています", requestId = crypto.randomUUID()) {
  return request("/lobby/chat", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ text, requestId }),
  });
}
async function read(user?: ChatUser, suffix = "") {
  const response = await request(
    `/lobby/chat${suffix}`,
    user ? { headers: user.headers } : undefined,
  );
  expect(response.status).toBe(200);
  return lobbyChatSchema.parse(await response.json());
}
test("閲覧は公開、投稿は本人認証・プロフィール完成・同一Originが必要", async () => {
  expect((await read()).messages).toHaveLength(0);
  expect(
    (await request("/lobby/chat", { method: "POST", headers: { Origin: origin } })).status,
  ).toBe(401);
  const incomplete = await fixture(false);
  expect((await post(incomplete)).status).toBe(403);
  const user = await fixture();
  expect((await post(user)).status).toBe(200);
  expect(
    (
      await request("/lobby/chat", {
        method: "POST",
        headers: { ...user.headers, Origin: "https://other.invalid" },
        body: JSON.stringify({ text: "x", requestId: crypto.randomUUID() }),
      })
    ).status,
  ).toBe(403);
  const publicPage = await read();
  expect(publicPage.messages[0].own).toBe(false);
  expect(JSON.stringify(publicPage)).not.toContain(user.id);
  expect((await read(user)).messages[0].own).toBe(true);
});
test("名前設定済みゲストも投稿・再送・通報でき、間隔・回数制限と運営停止を受ける", async () => {
  const user = await guestFixture(),
    owner = await fixture(),
    id = crypto.randomUUID();
  expect((await post(user, "ゲストの募集", id)).status).toBe(200);
  expect((await post(user, "ゲストの募集", id)).status).toBe(200);
  expect((await post(user, "別の募集")).status).toBe(429);
  expect((await read(user)).messages[0]).toMatchObject({ own: true, senderName: "ゲスト投稿者" });
  expect(JSON.stringify(await read())).not.toContain(user.id);
  await seedMessages(owner, 6);
  const messages = (await read()).messages.filter((m) => m.senderName !== "ゲスト投稿者");
  const report = (messageId: string) =>
    request("/lobby/chat/reports", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ messageId }),
    });
  expect((await report(messages[0]!.id)).status).toBe(201);
  expect((await report(messages[0]!.id)).status).toBe(200);
  for (const message of messages.slice(1, 5)) expect((await report(message.id)).status).toBe(201);
  expect((await report(messages[5]!.id)).status).toBe(429);
  const senderId = (await read(user)).messages.find((m) => m.own)!.senderId;
  const moderate = (body: unknown) =>
    request(
      "/admin/lobby-chat",
      { method: "POST", headers: owner.headers, body: JSON.stringify(body) },
      owner.id,
    );
  expect((await moderate({ action: "stop", senderId, stopped: true })).status).toBe(200);
  expect((await post(user, "停止中")).status).toBe(403);
  expect((await read(user)).postingStopped).toBe(true);
  await moderate({ action: "stop", senderId, stopped: false });
  await moderate({ action: "accepting", accepting: false });
  expect((await post(user, "全体停止中")).status).toBe(403);
  await moderate({ action: "accepting", accepting: true });
  await db.prepare("UPDATE user SET guestNameCustomized=0 WHERE id=?").bind(user.id).run();
  expect((await post(user, "未設定名")).status).toBe(403);
});
test("100文字の境界と絵文字・空欄・URL禁止をサーバーで検証する", async () => {
  const user = await fixture();
  for (const text of [
    "",
    "x".repeat(101),
    "https://example.test",
    "www.example.test",
    "example.com",
  ])
    expect((await post(user, text)).status).toBe(400);
  expect((await post(user, "👨‍👩‍👧‍👦".repeat(100))).status).toBe(200);
});
test("同時送信・別セッションでも10秒に1件、同じ投稿の再送は一度だけ確定する", async () => {
  const user = await fixture(),
    id = crypto.randomUUID();
  const responses = await Promise.all([post(user, "同じ投稿", id), post(user, "同じ投稿", id)]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect((await read()).messages).toHaveLength(1);
  expect((await post(user, "別の投稿")).status).toBe(429);
  expect((await post(user, "変更した本文", id)).status).toBe(409);
  await db
    .prepare("UPDATE lobby_chat_senders SET last_sent_at_ms=? WHERE account_id=?")
    .bind(Date.now() - 10000, user.id)
    .run();
  const pair = await Promise.all([post(user, "次の募集"), post(user, "同時の募集")]);
  expect(pair.map((r) => r.status).sort()).toEqual([200, 429]);
});
test("送信制限は投稿削除後も維持し、受理済みの再送は削除投稿を復活させない", async () => {
  const user = await fixture(),
    id = crypto.randomUUID();
  await post(user, "削除する投稿", id);
  await db.prepare("DELETE FROM lobby_chat_messages").run();
  const retry = await post(user, "削除する投稿", id);
  expect(retry.status).toBe(200);
  expect(((await retry.json()) as { message: unknown }).message).toBeNull();
  expect((await post(user, "別の投稿")).status).toBe(429);
  expect((await read()).messages).toHaveLength(0);
});
test("全体停止と本人停止は直接APIにも適用し、履歴閲覧は続けられる", async () => {
  const user = await fixture();
  await post(user);
  await db.prepare("UPDATE lobby_chat_settings SET accepting=0").run();
  expect((await post(user, "new")).status).toBe(403);
  expect((await read()).acceptingPosts).toBe(false);
  await db.prepare("UPDATE lobby_chat_settings SET accepting=1").run();
  await db.prepare("UPDATE lobby_chat_senders SET stopped=1").run();
  expect((await post(user, "new")).status).toBe(403);
  expect((await read(user)).postingStopped).toBe(true);
  expect((await read()).messages).toHaveLength(1);
});
async function seedMessages(
  user: Awaited<ReturnType<typeof fixture>>,
  count: number,
  start = Date.now(),
) {
  await db
    .prepare("INSERT OR IGNORE INTO lobby_chat_senders(account_id,public_id) VALUES(?,?)")
    .bind(user.id, crypto.randomUUID())
    .run();
  for (let from = 0; from < count; from += 80)
    await db.batch(
      Array.from({ length: Math.min(80, count - from) }, (_, i) =>
        db
          .prepare(
            "INSERT INTO lobby_chat_messages(id,account_id,body,sent_at_ms,request_id,body_hash) VALUES(?,?,?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            user.id,
            String(from + i),
            start - (count - from - i),
            crypto.randomUUID(),
            "hash",
          ),
      ),
    );
}
test("初回50件と過去取得、501件で最新500件だけを保持する", async () => {
  const user = await fixture();
  await seedMessages(user, 501);
  const page = await read();
  expect(page.messages).toHaveLength(50);
  expect(page.nextCursor).not.toBeNull();
  const older = await read(undefined, `?before=${page.nextCursor}`);
  expect(older.messages).toHaveLength(50);
  expect(older.messages.every((m) => m.sentAtMs <= page.messages[0].sentAtMs)).toBe(true);
  const full = await read(undefined, "?limit=500");
  expect(full.messages).toHaveLength(500);
  expect(full.messages[0].text).toBe("1");
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM lobby_chat_messages")
        .first<{ count: number }>()
    )?.count,
  ).toBe(500);
});
test("7日の期限で直ちに取得対象外になり、定期処理で通常履歴と再送記録を削除する", async () => {
  const user = await fixture();
  await seedMessages(user, 1, Date.now() - lobbyRetentionMs);
  expect((await read()).messages).toHaveLength(0);
  await cleanupLobbyChat(db);
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM lobby_chat_messages")
        .first<{ count: number }>()
    )?.count,
  ).toBe(0);
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM lobby_chat_requests")
        .first<{ count: number }>()
    )?.count,
  ).toBe(0);
});
test("通報はログイン必須、重複せず、証拠は通常投稿を削除しても別の7日だけ保持する", async () => {
  const user = await fixture();
  await post(user);
  const message = (await read()).messages[0];
  const input = {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ messageId: message.id }),
  };
  expect(
    (await request("/lobby/chat/reports", { ...input, headers: { Origin: origin } })).status,
  ).toBe(401);
  expect((await request("/lobby/chat/reports", input)).status).toBe(201);
  expect((await request("/lobby/chat/reports", input)).status).toBe(200);
  await db.prepare("DELETE FROM lobby_chat_messages").run();
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM lobby_chat_reports")
        .first<{ count: number }>()
    )?.count,
  ).toBe(1);
  await db
    .prepare("UPDATE lobby_chat_reports SET reported_at_ms=?")
    .bind(Date.now() - lobbyRetentionMs)
    .run();
  const admin = await request("/admin/lobby-chat", { headers: user.headers }, user.id);
  expect(lobbyAdminSchema.parse(await admin.json()).reports).toHaveLength(0);
  await cleanupLobbyChat(db);
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM lobby_chat_reports")
        .first<{ count: number }>()
    )?.count,
  ).toBe(0);
});
test("通報は直近1時間で5件まで、重複は件数を消費せず、期限後は再び受け付ける", async () => {
  const user = await fixture();
  for (let i = 0; i < 7; i++) {
    await db.prepare("UPDATE lobby_chat_senders SET last_sent_at_ms=0").run();
    expect((await post(user, `発言${i}`)).status).toBe(200);
  }
  const messages = (await read()).messages;
  const report = (id: string) =>
    request("/lobby/chat/reports", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ messageId: id }),
    });
  const concurrent = await Promise.all(messages.map((m) => report(m.id)));
  expect(concurrent.filter((r) => r.status === 201)).toHaveLength(5);
  expect(concurrent.filter((r) => r.status === 429)).toHaveLength(2);
  const accepted = await db
    .prepare("SELECT message_id FROM lobby_chat_reports LIMIT 1")
    .first<{ message_id: string }>();
  expect((await report(accepted!.message_id)).status).toBe(200);
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM lobby_chat_reports")
        .first<{ count: number }>()
    )?.count,
  ).toBe(5);
  const blocked = messages[concurrent.findIndex((r) => r.status === 429)];
  await db
    .prepare("UPDATE lobby_chat_reports SET reported_at_ms=?")
    .bind(Date.now() - 3600000)
    .run();
  expect((await report(blocked.id)).status).toBe(201);
});
test("運営の一覧と削除・投稿停止・解除・全体停止は管理者のみ操作できる", async () => {
  const user = await fixture(),
    other = await fixture();
  await post(other);
  const message = (await read()).messages[0];
  expect((await request("/admin/lobby-chat", { headers: other.headers }, user.id)).status).toBe(
    403,
  );
  for (const input of [
    { action: "stop", senderId: message.senderId, stopped: true },
    { action: "stop", senderId: message.senderId, stopped: false },
    { action: "accepting", accepting: false },
    { action: "accepting", accepting: true },
    { action: "delete", messageId: message.id },
  ]) {
    const response = await request(
      "/admin/lobby-chat",
      { method: "POST", headers: user.headers, body: JSON.stringify(input) },
      user.id,
    );
    expect(response.status).toBe(200);
  }
  expect((await read()).messages).toHaveLength(0);
});
test("退会受付で本人投稿を即時除外、相手を維持し、後続投稿と再送を拒否する", async () => {
  const user = await fixture(),
    other = await fixture();
  await post(user);
  await post(other);
  expect(await requestDeletion({ ...env, APP_DB: db }, user.id, crypto.randomUUID())).toBe(true);
  expect((await read()).messages).toHaveLength(1);
  expect((await post(user)).status).toBe(401);
  await processDeletions({ ...env, APP_DB: db });
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM lobby_chat_messages WHERE account_id=?")
        .bind(user.id)
        .first<{ count: number }>()
    )?.count,
  ).toBe(0);
  expect((await read()).messages).toHaveLength(1);
});
test("6ゲームのルームは状態分類・更新日時をサーバーで並べ、定員と20件の境界を守る", async () => {
  for (let i = 0; i < 27; i++) {
    const game = gameIds[i % 6],
      capacity = gameCatalog[game].capacity,
      rank = i % 3,
      status = rank === 2 ? "playing" : "waiting";
    await writeRoomIndex(db, {
      revision: 1,
      closed: false,
      retryAtMs: 0,
      metadata: {
        id: String(10000 + i),
        instanceId: crypto.randomUUID(),
        game,
        ...(gameCatalog[game].hasModes ? { mode: "singles" as const } : {}),
        timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
        status,
        hostName: "募集者",
        hostAvatarUrl: null,
        humanCount: rank === 0 ? 1 : capacity,
        cpuCount: 0,
        capacity,
        openSeats: rank === 0 ? capacity - 1 : 0,
        updatedAtMs: 1000 + i,
      },
    });
  }
  const firstResponse = await request("/lobby/rooms"),
    first = lobbyRoomsSchema.parse(await firstResponse.json());
  expect(first.rooms).toHaveLength(20);
  expect(new Set(first.rooms.map((r) => r.game)).size).toBe(6);
  expect(first.rooms.slice(0, 9).every((r) => r.status === "waiting" && r.openSeats > 0)).toBe(
    true,
  );
  expect(first.rooms.slice(9, 18).every((r) => r.status === "waiting" && r.openSeats === 0)).toBe(
    true,
  );
  const second = lobbyRoomsSchema.parse(
    await (await request(`/lobby/rooms?cursor=${first.nextCursor}`)).json(),
  );
  expect(second.rooms).toHaveLength(7);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.rooms, ...second.rooms].map((r) => r.id)).size).toBe(27);
  const filtered = lobbyRoomsSchema.parse(await (await request("/lobby/rooms?capacity=2")).json());
  expect(filtered.rooms.every((r) => r.capacity === 2)).toBe(true);
  expect((await request("/lobby/rooms?capacity=3")).status).toBe(400);
});

test("最近の対局はゲーム横断の開始順で最新20件、人間限定は先に絞る", async () => {
  const user = await fixture();
  // D1への書込み時間にかかわらず、検証する開始順を固定します。
  const startedAt = Date.now();
  for (let i = 0; i < 22; i++) {
    const record = fixtureRecord(user.id, i);
    record.startedAtMs = startedAt + i;
    await writeMatch(db, record);
  }
  const human = humanFixtureRecord(user.id, 100);
  human.startedAtMs = startedAt - 1000;
  await writeMatch(db, human);
  const shogi = humanShogiRecord(user.id);
  shogi.record.startedAtMs = startedAt - 2000;
  await saveShogiFixture(shogi, db);
  const all = (await (await request("/lobby/matches")).json()) as { matches: { id: string }[] };
  expect(all.matches).toHaveLength(20);
  expect(all.matches.some((m) => m.id === human.id)).toBe(false);
  const filtered = (await (await request("/lobby/matches?humanOnly=true")).json()) as {
    matches: { id: string; game: string }[];
  };
  expect(filtered.matches.map((m) => m.id)).toEqual([human.id, shogi.record.id]);
});
test("総合ロビー計測は全体だけに入り、ゲーム開始率の分母に混ぜない", async () => {
  const now = Date.now(),
    day = japanDay(now),
    view = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO analytics_pageviews(id,visitor_id,account_id,is_test,page,game,started_at_ms) VALUES(?,?,NULL,0,'general-lobby',NULL,?)",
    )
    .bind(view, "visitor", now - 1000)
    .run();
  await db.prepare("INSERT INTO analytics_dwell VALUES(?,?,?)").bind(view, day, 500).run();
  const query = {
    from: day,
    to: day,
    bucket: "day" as const,
    game: "all" as const,
    includeInternal: "false" as const,
  };
  const all = await readAnalytics({ ...env, APP_DB: db }, query);
  expect(all.summary.generalLobbyViews).toBe(1);
  expect(all.summary.generalLobbyDwellMs).toBe(500);
  expect(all.summary.conversionEligible).toBe(0);
  const game = await readAnalytics({ ...env, APP_DB: db }, { ...query, game: "four-reversi" });
  expect(game.summary.generalLobbyViews).toBe(0);
  expect(game.summary.pageViews).toBe(0);
});
