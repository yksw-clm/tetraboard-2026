import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, afterEach, expect, test, vi } from "vitest";
import {
  lobbyChatSchema,
  tournamentChatSchema,
  lobbyAdminSchema,
} from "@tetraboard/protocol/general-lobby";
import { legalVersion } from "@tetraboard/protocol/privacy";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { cleanupLobbyChat, lobbyRetentionMs } from "../src/lobby/chatStore";
import { requestDeletion } from "../src/privacy/deletion";
import { guestChatMergeStatements } from "../src/lobby/mergeGuestChat";

const db = (env as typeof env & { LOBBY_TEST_DB: D1Database }).LOBBY_TEST_DB;
beforeAll(async () => {
  await applyD1Migrations(
    db,
    (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.batch(
    [
      "lobby_chat_reports",
      "lobby_chat_messages",
      "lobby_chat_requests",
      "lobby_chat_senders",
      "tournament_entries",
      "tournaments",
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
  await db.prepare("UPDATE lobby_chat_settings SET accepting=1").run();
});
const request = (path: string, init?: RequestInit, owner?: string) =>
  worker.fetch(
    new Request(`${origin}/api${path}`, init),
    { ...env, APP_DB: db, ADMIN_ACCOUNT_IDS: owner ? JSON.stringify([owner]) : "[]" },
    { waitUntil: () => {} } as unknown as ExecutionContext,
  );
const user = () => accountFixture(true, crypto.randomUUID(), db);
type User = Pick<Awaited<ReturnType<typeof user>>, "id" | "headers">;
async function tournament(id = 1, finalized: number | null = null, published = true) {
  const key = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO tournaments(key,public_id,name,starts_at_ms,ends_at_ms,published,finalized_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      key,
      id,
      `大会${id}`,
      Date.now() + 3600000,
      Date.now() + 7200000,
      Number(published),
      finalized,
      Date.now(),
      Date.now(),
    )
    .run();
  return { id, key };
}
async function enroll(t: Awaited<ReturnType<typeof tournament>>, u: User) {
  await db
    .prepare(
      "INSERT INTO tournament_entries(id,tournament_key,account_id,entered_at_ms) VALUES(?,?,?,?)",
    )
    .bind(crypto.randomUUID(), t.key, u.id, Date.now())
    .run();
}
const path = (id: number | null) => (id === null ? "/lobby/chat" : `/tournaments/${id}/chat`);
const post = (
  id: number | null,
  u: User,
  text = "よろしくお願いします",
  requestId = crypto.randomUUID(),
) =>
  request(path(id), {
    method: "POST",
    headers: u.headers,
    body: JSON.stringify({ text, requestId }),
  });
async function read(id: number | null, u?: User, suffix = "") {
  const response = await request(path(id) + suffix, u ? { headers: u.headers } : undefined);
  expect(response.status).toBe(200);
  return (id === null ? lobbyChatSchema : tournamentChatSchema).parse(await response.json());
}
const moderate = (u: User, body: unknown) =>
  request(
    "/admin/lobby-chat",
    { method: "POST", headers: u.headers, body: JSON.stringify(body) },
    u.id,
  );

test("公開大会だけを閲覧でき、本人の有効なエントリーと名前設定・Originを投稿時に検査する", async () => {
  const t = await tournament(),
    u = await user();
  expect(await read(t.id)).toMatchObject({ entered: false, messages: [], closesAtMs: null });
  expect((await request(path(t.id), { method: "POST", headers: { Origin: origin } })).status).toBe(
    401,
  );
  expect((await post(t.id, u)).status).toBe(403);
  await enroll(t, u);
  expect(
    (await post(t.id, { ...u, headers: { ...u.headers, Origin: "https://other.invalid" } })).status,
  ).toBe(403);
  expect((await post(t.id, u)).status).toBe(200);
  expect(await read(t.id, u)).toMatchObject({ entered: true, messages: [{ own: true }] });
  expect(JSON.stringify(await read(t.id))).not.toContain(u.id);
  await db.prepare("UPDATE tournament_entries SET deleted=1 WHERE account_id=?").bind(u.id).run();
  expect((await post(t.id, u)).status).toBe(403);
  await tournament(2, null, false);
  for (const invalid of ["0", "2", "999", "bad"])
    expect((await request(`/tournaments/${invalid}/chat`)).status).toBe(404);
});

test("名前設定済みのゲスト参加者も投稿でき、登録やエントリーを暗黙に行わない", async () => {
  const t = await tournament();
  const response = await request("/account/guest", {
    method: "POST",
    headers: { Origin: origin, "X-Legal-Consent": legalVersion },
    body: JSON.stringify({ name: "大会ゲスト" }),
  });
  expect(response.status).toBe(201);
  const profile = (await response.json()) as { profileId: string };
  const stored = await db
    .prepare("SELECT id FROM user WHERE publicProfileId=?")
    .bind(profile.profileId)
    .first<{ id: string }>();
  const cookie = response.headers
    .getSetCookie()
    .find((v) => v.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const guest = {
    id: stored!.id,
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
  };
  expect((await post(t.id, guest)).status).toBe(403);
  await enroll(t, guest);
  expect((await post(t.id, guest)).status).toBe(200);
  expect((await read(t.id, guest)).messages[0]).toMatchObject({
    senderName: "大会ゲスト",
    own: true,
  });
  await db.prepare("UPDATE user SET guestNameCustomized=0 WHERE id=?").bind(guest.id).run();
  expect((await post(t.id, guest)).status).toBe(403);
});

test("大会ごとの履歴・再送・通報を分離し、総合ロビーへ混ぜない", async () => {
  const t = await tournament(),
    other = await tournament(2),
    u = await user(),
    v = await user(),
    w = await user();
  await enroll(t, u);
  await enroll(other, v);
  await enroll(other, u);
  const id = crypto.randomUUID();
  expect((await post(t.id, u, "大会1", id)).status).toBe(200);
  expect((await post(other.id, v, "大会2")).status).toBe(200);
  expect((await post(null, w, "ロビー")).status).toBe(200);
  expect((await read(t.id)).messages.map((m) => m.text)).toEqual(["大会1"]);
  expect((await read(other.id)).messages.map((m) => m.text)).toEqual(["大会2"]);
  expect((await read(null)).messages.map((m) => m.text)).toEqual(["ロビー"]);
  expect((await post(t.id, u, "大会1", id)).status).toBe(200);
  expect((await post(other.id, u, "大会1", id)).status).toBe(409);
  const messageId = (await read(t.id)).messages[0]!.id;
  const report = (scope: number) =>
    request(`${path(scope)}/reports`, {
      method: "POST",
      headers: w.headers,
      body: JSON.stringify({ messageId }),
    });
  expect((await report(other.id)).status).toBe(429);
  expect((await report(t.id)).status).toBe(201);
  expect((await report(t.id)).status).toBe(200);
  const admin = await request(
    `/admin/lobby-chat?tournamentId=${t.id}`,
    { headers: w.headers },
    w.id,
  );
  expect(lobbyAdminSchema.parse(await admin.json()).reports).toMatchObject([
    { tournamentId: t.id, messageId },
  ]);
  expect(
    (await request(`/admin/lobby-chat?tournamentId=${t.id}`, { headers: u.headers }, w.id)).status,
  ).toBe(403);
});

test("ゲスト統合後も大会の所属・公開送信者ID・再送台帳と共通の送信間隔を引き継ぐ", async () => {
  const t = await tournament(),
    guest = await user(),
    account = await user();
  await enroll(t, guest);
  await enroll(t, account);
  const id = crypto.randomUUID();
  await post(t.id, guest, "引き継ぐ発言", id);
  const message = (await read(t.id)).messages[0]!;
  await db.batch(guestChatMergeStatements(db, guest.id, account.id));
  expect((await read(t.id, account)).messages[0]).toMatchObject({
    id: message.id,
    senderId: message.senderId,
    own: true,
  });
  expect((await read(null)).messages).toHaveLength(0);
  expect((await post(t.id, account, "引き継ぐ発言", id)).status).toBe(200);
  expect((await post(null, account)).status).toBe(429);
});

test("総合ロビーと別大会への同時送信にも共通の10秒制限を適用し、境界と再送で重複させない", async () => {
  const t = await tournament(),
    other = await tournament(2),
    u = await user();
  await enroll(t, u);
  await enroll(other, u);
  const now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now),
    id = crypto.randomUUID();
  expect((await post(t.id, u, "最初", id)).status).toBe(200);
  expect((await post(t.id, u, "最初", id)).status).toBe(200);
  clock.mockReturnValue(now + 9999);
  expect((await post(null, u)).status).toBe(429);
  clock.mockReturnValue(now + 10000);
  const results = await Promise.all([post(null, u), post(other.id, u)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
  expect((await read(t.id)).messages).toHaveLength(1);
  expect((await read(null)).messages.length + (await read(other.id)).messages.length).toBe(1);
});

test("開催前・開催中・結果待機・結果確定後に投稿でき、確定24時間の境界で受付終了する", async () => {
  const t = await tournament(),
    u = await user();
  await enroll(t, u);
  const now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const stages = [
    { start: now + 3600000, end: now + 7200000 },
    { start: now - 3600000, end: now + 3600000 },
    { start: now - 7200000, end: now - 3600000 },
  ];
  for (const [index, stage] of stages.entries()) {
    await db
      .prepare("UPDATE tournaments SET starts_at_ms=?,ends_at_ms=? WHERE key=?")
      .bind(stage.start, stage.end, t.key)
      .run();
    clock.mockReturnValue(now + index * 10000);
    expect((await post(t.id, u)).status).toBe(200);
  }
  clock.mockReturnValue(now + 30000);
  await db
    .prepare("UPDATE tournaments SET finalized_at_ms=? WHERE key=?")
    .bind(now + 30000 - 86400000 + 1, t.key)
    .run();
  expect((await post(t.id, u)).status).toBe(200);
  expect(await read(t.id, u)).toMatchObject({ acceptingPosts: true, closesAtMs: now + 30001 });
  clock.mockReturnValue(now + 30001);
  expect((await post(t.id, u)).status).toBe(403);
  expect(await read(t.id, u)).toMatchObject({ acceptingPosts: false });
  expect((await read(t.id)).messages).toHaveLength(4);
});

test("大会単位の停止・全体停止・利用者停止と削除を管理APIで適用する", async () => {
  const t = await tournament(),
    other = await tournament(2),
    u = await user(),
    admin = await user();
  await enroll(t, u);
  await enroll(other, u);
  expect(
    (await moderate(admin, { action: "accepting", accepting: false, tournamentId: t.id })).status,
  ).toBe(200);
  expect((await post(t.id, u)).status).toBe(403);
  expect((await post(other.id, u)).status).toBe(200);
  const message = (await read(other.id)).messages[0]!;
  expect((await moderate(admin, { action: "accepting", accepting: false })).status).toBe(200);
  expect((await post(null, u)).status).toBe(403);
  expect((await post(other.id, u)).status).toBe(403);
  await moderate(admin, { action: "accepting", accepting: true });
  await moderate(admin, { action: "accepting", accepting: true, tournamentId: t.id });
  await moderate(admin, { action: "stop", senderId: message.senderId, stopped: true });
  expect((await read(t.id, u)).postingStopped).toBe(true);
  expect((await post(t.id, u)).status).toBe(403);
  await moderate(admin, { action: "delete", messageId: message.id });
  expect((await read(other.id)).messages).toHaveLength(0);
  await moderate(admin, { action: "stop", senderId: message.senderId, stopped: false });
  expect((await read(t.id, u)).postingStopped).toBe(false);
});

test("大会別に最新500件を保持し、50件ずつの取得と7日期限・退会の除外を共通処理で行う", async () => {
  const t = await tournament(),
    other = await tournament(2),
    u = await user(),
    v = await user();
  await enroll(t, u);
  await enroll(other, v);
  await post(other.id, v, "別大会に残す");
  await post(null, u, "ロビーに残す");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (let start = 0; start < 501; start += 80)
    await db.batch(
      Array.from({ length: Math.min(80, 501 - start) }, (_, i) =>
        db
          .prepare(
            "INSERT INTO lobby_chat_messages(id,account_id,body,sent_at_ms,request_id,body_hash,tournament_id) VALUES(?,?,?,?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            u.id,
            String(start + i),
            now - 501 + start + i,
            crypto.randomUUID(),
            "hash",
            t.id,
          ),
      ),
    );
  const first = await read(t.id),
    all = await read(t.id, undefined, "?limit=500");
  expect(first.messages).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  expect(all.messages).toHaveLength(500);
  expect(all.messages[0]!.text).toBe("1");
  expect((await read(t.id, undefined, `?before=${first.nextCursor}`)).messages.at(-1)!.text).toBe(
    "450",
  );
  expect((await read(other.id)).messages).toHaveLength(1);
  expect((await read(null)).messages).toHaveLength(1);
  await db
    .prepare("UPDATE lobby_chat_messages SET sent_at_ms=? WHERE tournament_id=?")
    .bind(now - lobbyRetentionMs, t.id)
    .run();
  expect((await read(t.id)).messages).toHaveLength(0);
  await cleanupLobbyChat(db);
  expect(
    (await db
      .prepare("SELECT COUNT(*) AS n FROM lobby_chat_messages WHERE tournament_id=?")
      .bind(t.id)
      .first<{ n: number }>())!.n,
  ).toBe(0);
  await requestDeletion({ ...env, APP_DB: db }, v.id, "chat-deletion-receipt");
  expect((await read(other.id)).messages).toHaveLength(0);
  expect((await read(null)).messages).toHaveLength(1);
});
