import { env } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { lobbyAdminSchema, lobbyPostResultSchema } from "@tetraboard/protocol/general-lobby";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountFixture, origin } from "./accountFixtures";
import { cleanupLobbyChat } from "../src/adapters/community/chatCleanup";
import { lobbyRetentionMs } from "@tetraboard/context-community";
import { processDeletions } from "../src/flows/accountPurge/processDeletions";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { guestChatMergeStatements } from "../src/adapters/community/guestMergeWrites";

import { useTournamentChatFixtures } from "./tournamentChatFixtures";

const { db, request, user, tournament, enroll, path, post, read, moderate } =
  useTournamentChatFixtures();

test("公開大会だけを閲覧でき、本人の有効なエントリーと名前設定・Originを投稿時に検査する", async () => {
  const t = await tournament(),
    u = await user();
  expect(await read(t.id)).toMatchObject({ entered: false, messages: [], closesAtMs: null });
  expect((await request(path(t.id), { method: "POST", headers: { Origin: origin } })).status).toBe(
    401,
  );
  expect((await post(t.id, u)).status).toBe(403);
  const incomplete = await accountFixture(false, crypto.randomUUID(), db);
  await enroll(t, incomplete);
  expect((await post(t.id, incomplete)).status).toBe(403);
  await enroll(t, u);
  expect(
    (await post(t.id, { ...u, headers: { ...u.headers, Origin: "https://other.invalid" } })).status,
  ).toBe(403);
  expect((await post(t.id, u)).status).toBe(200);
  expect(await read(t.id, u)).toMatchObject({ entered: true, messages: [{ own: true }] });
  expect((await read(t.id)).messages[0]!.own).toBe(false);
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
  expect(await read(t.id, guest)).toMatchObject({ entered: false, messages: [] });
  await enroll(t, guest);
  expect((await post(t.id, guest)).status).toBe(200);
  const subjectId = (await read(t.id, guest)).messages[0]!.id;
  const report = { method: "POST", body: JSON.stringify({ messageId: subjectId }) };
  expect(
    (await request(`${path(t.id)}/reports`, { ...report, headers: { Origin: origin } })).status,
  ).toBe(401);
  expect(
    (await request(`${path(t.id)}/reports`, { ...report, headers: guest.headers })).status,
  ).toBe(201);
  expect((await read(t.id, guest)).messages[0]).toMatchObject({
    senderName: "大会ゲスト",
    own: true,
  });
  await db.prepare("UPDATE user SET guestNameCustomized=0 WHERE id=?").bind(guest.id).run();
  expect((await post(t.id, guest)).status).toBe(403);
});

test("投稿は100文字まで受け付け、URLを拒否する", async () => {
  const t = await tournament();
  const u = await user();
  await enroll(t, u);
  for (const text of [
    "",
    "x".repeat(101),
    "https://example.test",
    "www.example.test",
    "example.com",
  ])
    expect((await post(t.id, u, text)).status).toBe(400);
  expect((await post(t.id, u, "👨‍👩‍👧‍👦".repeat(100))).status).toBe(200);
});

test("大会ごとの履歴・再送・通報を分離する", async () => {
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
  expect((await read(t.id)).messages.map((m) => m.text)).toEqual(["大会1"]);
  expect((await read(other.id)).messages.map((m) => m.text)).toEqual(["大会2"]);
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
    other = await tournament(2),
    guest = await user(),
    account = await user();
  await enroll(t, guest);
  await enroll(t, account);
  await enroll(other, account);
  const id = crypto.randomUUID();
  await post(t.id, guest, "引き継ぐ発言", id);
  const message = (await read(t.id)).messages[0]!;
  await db.batch(guestChatMergeStatements(db, guest.id, account.id));
  expect((await read(t.id, account)).messages[0]).toMatchObject({
    id: message.id,
    senderId: message.senderId,
    own: true,
  });
  expect((await read(other.id)).messages).toHaveLength(0);
  expect((await post(t.id, account, "引き継ぐ発言", id)).status).toBe(200);
  expect((await post(other.id, account)).status).toBe(429);
});

test("別大会と同じ大会への同時送信に共通の10秒制限を適用し、境界と再送で重複させない", async () => {
  const t = await tournament(),
    other = await tournament(2),
    u = await user();
  await enroll(t, u);
  await enroll(other, u);
  const now = Date.now(),
    clock = vi.spyOn(Date, "now").mockReturnValue(now),
    id = crypto.randomUUID();
  const retries = await Promise.all([post(t.id, u, "最初", id), post(t.id, u, "最初", id)]);
  expect(retries.map((r) => r.status)).toEqual([200, 200]);
  expect((await post(t.id, u, "変更した本文", id)).status).toBe(409);
  clock.mockReturnValue(now + 9999);
  expect((await post(other.id, u)).status).toBe(429);
  clock.mockReturnValue(now + 10000);
  const results = await Promise.all([post(t.id, u), post(other.id, u)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
  const texts = (await Promise.all([read(t.id), read(other.id)])).flatMap((page) =>
    page.messages.map((m) => m.text),
  );
  expect(texts).toEqual(["最初", "よろしくお願いします"]);
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
  expect((await request("/admin/lobby-chat", { headers: u.headers }, admin.id)).status).toBe(403);
  expect((await request("/admin/lobby-chat", undefined, admin.id)).status).toBe(401);
  expect(
    (
      await moderate(
        { ...admin, headers: { ...admin.headers, Origin: "https://other.invalid" } },
        {
          action: "accepting",
          accepting: false,
        },
      )
    ).status,
  ).toBe(403);
  expect(
    (await moderate(admin, { action: "accepting", accepting: false, tournamentId: t.id })).status,
  ).toBe(200);
  expect((await post(t.id, u)).status).toBe(403);
  const requestId = crypto.randomUUID();
  expect((await post(other.id, u, "削除後も再送を受理したままにする", requestId)).status).toBe(200);
  const message = (await read(other.id)).messages[0]!;
  expect((await moderate(admin, { action: "accepting", accepting: false })).status).toBe(200);
  expect((await post(t.id, u)).status).toBe(403);
  expect((await read(other.id)).messages).toHaveLength(1);
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
  const retry = await post(other.id, u, "削除後も再送を受理したままにする", requestId);
  expect(retry.status).toBe(200);
  expect(lobbyPostResultSchema.parse(await retry.json()).message).toBeNull();
  expect((await post(other.id, u, "別の投稿")).status).toBe(429);
  expect((await read(other.id)).messages).toHaveLength(0);
});

test("大会別に最新500件を保持し、50件ずつの取得と7日期限・退会の除外を共通処理で行う", async () => {
  const t = await tournament(),
    other = await tournament(2),
    u = await user(),
    v = await user();
  await enroll(t, u);
  await enroll(other, v);
  const otherRequestId = crypto.randomUUID();
  expect((await post(other.id, v, "別大会に残す", otherRequestId)).status).toBe(200);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (let start = 0; start < 500; start += 80)
    await db.batch(
      Array.from({ length: Math.min(80, 500 - start) }, (_, i) =>
        db
          .prepare(
            "INSERT INTO lobby_chat_messages(id,account_id,body,sent_at_ms,request_id,body_hash,tournament_id) VALUES(?,?,?,?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            u.id,
            String(start + i),
            now - 500 + start + i,
            crypto.randomUUID(),
            "hash",
            t.id,
          ),
      ),
    );
  expect((await post(t.id, u, "500")).status).toBe(200);
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
  await db
    .prepare("UPDATE lobby_chat_messages SET sent_at_ms=? WHERE tournament_id=?")
    .bind(now - lobbyRetentionMs, t.id)
    .run();
  await db
    .prepare("UPDATE lobby_chat_requests SET sent_at_ms=? WHERE tournament_id=?")
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
  expect(
    await db.prepare("SELECT 1 FROM lobby_chat_requests WHERE tournament_id=?").bind(t.id).first(),
  ).toBeNull();
  await requestDeletion({ ...env, APP_DB: db }, v.id, "chat-deletion-receipt");
  expect((await read(other.id)).messages).toHaveLength(0);
  expect((await post(other.id, v)).status).toBe(401);
  expect((await post(other.id, v, "別大会に残す", otherRequestId)).status).toBe(401);
  await processDeletions({ ...env, APP_DB: db });
  expect(
    await db.prepare("SELECT 1 FROM lobby_chat_messages WHERE account_id=?").bind(v.id).first(),
  ).toBeNull();
});

test("通報は全大会で直近1時間に5件までで、重複は件数を消費しない", async () => {
  const t = await tournament(),
    other = await tournament(2);
  const author = await user(),
    reporter = await user();
  await enroll(t, author);
  await enroll(other, author);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now");
  const subjects: { id: number; messageId: string }[] = [];
  for (let i = 0; i < 7; i++) {
    clock.mockReturnValue(now + i * 10000);
    const id = i % 2 === 0 ? t.id : other.id;
    const response = await post(id, author, `通報対象${i}`);
    expect(response.status).toBe(200);
    const message = lobbyPostResultSchema.parse(await response.json()).message!;
    subjects.push({ id, messageId: message.id });
  }
  const report = ({ id, messageId }: (typeof subjects)[number]) =>
    request(`${path(id)}/reports`, {
      method: "POST",
      headers: reporter.headers,
      body: JSON.stringify({ messageId }),
    });
  const results = await Promise.all(subjects.map(report));
  expect(results.filter((r) => r.status === 201)).toHaveLength(5);
  expect(results.filter((r) => r.status === 429)).toHaveLength(2);
  const accepted = subjects[results.findIndex((r) => r.status === 201)]!;
  const blocked = subjects[results.findIndex((r) => r.status === 429)]!;
  expect((await report(accepted)).status).toBe(200);
  expect((await report(blocked)).status).toBe(429);
  clock.mockReturnValue(now + 60000 + 3600000);
  expect((await report(blocked)).status).toBe(201);
});

test("全体通報一覧は大会横断の証拠と旧ロビーの証拠を期限内だけ管理者に返す", async () => {
  const t = await tournament(),
    other = await tournament(2);
  const admin = await user(),
    author = await user();
  await enroll(t, author);
  await enroll(other, admin);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const legacyId = crypto.randomUUID();
  const legacyText = "旧ロビーの保存済み発言";
  await db.batch([
    db
      .prepare(
        "INSERT INTO lobby_chat_messages(id,account_id,body,sent_at_ms,request_id,body_hash) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        legacyId,
        author.id,
        legacyText,
        now - lobbyRetentionMs + 1,
        crypto.randomUUID(),
        "hash",
      ),
    db
      .prepare(
        "INSERT INTO lobby_chat_reports(id,message_id,sender_account_id,sender_name,body,sent_at_ms,reporter_account_id,reported_at_ms) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        legacyId,
        legacyId,
        author.id,
        "旧投稿者",
        legacyText,
        now - lobbyRetentionMs + 1,
        admin.id,
        now - lobbyRetentionMs + 1,
      ),
  ]);
  const reportIds = [];
  for (const [id, sender] of [
    [t.id, author],
    [other.id, admin],
  ] as const) {
    const sent = lobbyPostResultSchema.parse(await (await post(id, sender)).json()).message!;
    expect((await read(id)).messages.map((m) => m.id)).toEqual([sent.id]);
    expect(
      (
        await request(`${path(id)}/reports`, {
          method: "POST",
          headers: admin.headers,
          body: JSON.stringify({ messageId: sent.id }),
        })
      ).status,
    ).toBe(201);
    expect((await moderate(admin, { action: "delete", messageId: sent.id })).status).toBe(200);
    reportIds.push(sent.id);
  }
  const reports = async (suffix = "") => {
    const response = await request(
      "/admin/lobby-chat" + suffix,
      { headers: admin.headers },
      admin.id,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return lobbyAdminSchema.parse(await response.json()).reports;
  };
  expect((await reports()).map((r) => r.messageId)).toEqual(
    expect.arrayContaining([...reportIds, legacyId]),
  );
  expect(await reports(`?tournamentId=${t.id}`)).toMatchObject([{ messageId: reportIds[0] }]);
  expect((await moderate(admin, { action: "resolve", reportId: legacyId })).status).toBe(200);
  expect((await reports()).find((r) => r.id === legacyId)).toMatchObject({
    status: "resolved",
    text: legacyText,
    tournamentId: null,
  });
  clock.mockReturnValue(now + 1);
  expect((await reports()).map((r) => r.messageId)).not.toContain(legacyId);
  await cleanupLobbyChat(db);
  expect(
    await db.prepare("SELECT id FROM lobby_chat_reports WHERE id=?").bind(legacyId).first(),
  ).toBeNull();
  expect(
    await db.prepare("SELECT id FROM lobby_chat_messages WHERE id=?").bind(legacyId).first(),
  ).toBeNull();
});
