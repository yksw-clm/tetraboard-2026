import { env } from "cloudflare:workers";
import { reportBoardPost } from "@tetraboard/context-community";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { afterEach, expect, test } from "vitest";
import { withAccountSessionCookies } from "../src/adapters/account/auth";
import { D1BoardReports } from "../src/adapters/community/boardReports";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { createGuestAccount } from "../src/routes/guestSession";
import { accountFixture, origin } from "./accountFixtures";
import {
  boardAdminPage,
  boardAdminRequest,
  boardPostFixture,
  boardRequest,
  postPath,
  reportPost,
  resetBoard,
} from "./boardFixtures";
import { fixTestTime } from "./fixedTimeFixture";
import { guest, link, request } from "./guestAccountsFixtures";
import { processFixtureDeletion } from "./privacyFixtures";

const db = env.APP_DB;
afterEach(resetBoard);

async function guestFixture(name?: string) {
  const request = new Request(origin, {
    headers: { Origin: origin, "X-Legal-Consent": legalVersion },
  });
  const response = await withAccountSessionCookies(request, async () => {
    const { id } = await createGuestAccount(request, env, name);
    return Response.json({ id });
  });
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("tetraboard-2026.guest="))!;
  const headers = { Origin: origin, Cookie: cookie.split(";")[0]! };
  const { id } = await response.json<{ id: string }>();
  return { id, headers };
}

test("通報はログイン中のゲストと登録者が使え、退会受付・ゲスト統合後は拒否する", async () => {
  const author = await accountFixture();
  const reporter = await accountFixture(false);
  const guest = await guestFixture("ゲスト");
  const unnamed = await guestFixture();
  const post = boardPostFixture({ accountId: author.id });
  const other = boardPostFixture({ accountId: author.id });
  await db.batch([post.statement, other.statement]);

  const unauthenticated = await reportPost(post.id, { Origin: origin });
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.json()).toEqual({ message: "ログインしてください。" });
  expect((await reportPost(post.id, { Cookie: reporter.cookie })).status).toBe(403);
  for (const account of [reporter, guest, unnamed]) {
    const response = await reportPost(post.id, account.headers);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ message: "通報を受け付けました。" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }

  await db
    .prepare("INSERT INTO guest_account_merges(guest_id,account_id,merged_at_ms) VALUES(?,?,?)")
    .bind(guest.id, author.id, Date.now())
    .run();
  expect(await requestDeletion(env, reporter.id, crypto.randomUUID())).toBe(true);
  // 本人確認と INSERT の間に退会受付・統合された要求も、新規と再送の両方を拒否します。
  for (const account of [reporter, guest]) {
    for (const { id } of [post, other]) {
      expect((await reportPost(id, account.headers)).status).toBe(401);
      expect(
        await reportBoardPost(
          new D1BoardReports(db),
          { accountId: account.id, postId: id, reason: "spam" },
          Date.now(),
        ),
      ).toBe("unavailable");
    }
  }
});

test("閉じた掲示板でも返信を通報でき、削除済み・退会者・入力不正を拒否する", async () => {
  const author = await accountFixture();
  const reporter = await accountFixture();
  const departing = await accountFixture();
  const root = boardPostFixture({ accountId: author.id });
  const leaf = boardPostFixture({ accountId: author.id });
  const reply = boardPostFixture({ accountId: author.id, parentId: root.id });
  const withdrawn = boardPostFixture({ accountId: departing.id });
  await db.batch([root.statement, leaf.statement, reply.statement, withdrawn.statement]);
  for (const post of [root, leaf])
    expect(
      (await boardRequest(postPath(post.id), { method: "DELETE", headers: author.headers })).status,
    ).toBe(204);
  await db
    .prepare("INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)")
    .bind(departing.id, Date.now(), crypto.randomUUID())
    .run();

  for (const id of [root.id, leaf.id, withdrawn.id, crypto.randomUUID()]) {
    const response = await reportPost(id, reporter.headers);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      message: "投稿が見つからないか、通報回数の上限に達しています。",
    });
  }
  expect((await reportPost("invalid", reporter.headers)).status).toBe(404);
  for (const input of [{ reason: "unknown" }, { reason: "spam", extra: true }, {}]) {
    const response = await reportPost(reply.id, reporter.headers, input);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "通報の理由を選んでください。" });
  }
  expect((await reportPost(reply.id, reporter.headers)).status).toBe(201);
  expect(
    await db.prepare("SELECT * FROM board_reports WHERE post_id=?").bind(reply.id).first(),
  ).toEqual({
    id: expect.any(String),
    post_id: reply.id,
    game_id: "reversi",
    parent_id: root.id,
    author_account_id: author.id,
    author_name: "登録名",
    body: reply.text,
    posted_at_ms: reply.postedAtMs,
    reason: "abuse",
    reporter_account_id: reporter.id,
    reported_at_ms: expect.any(Number),
    status: "open",
  });
});

test("並行する通報も1時間に5件までで、再通報は時間と理由を保持する", async () => {
  const clock = fixTestTime();
  const now = Date.now();
  const author = await accountFixture();
  const reporter = await accountFixture();
  const posts = Array.from({ length: 6 }, () => boardPostFixture({ accountId: author.id }));
  await db.batch(posts.map(({ statement }) => statement));
  const send = (id: string) => reportPost(id, reporter.headers);

  const concurrent = await Promise.all(posts.map(({ id }) => send(id)));
  expect(concurrent.map(({ status }) => status).sort()).toEqual([201, 201, 201, 201, 201, 429]);
  const blocked = posts[concurrent.findIndex(({ status }) => status === 429)]!;
  const accepted = posts[concurrent.findIndex(({ status }) => status === 201)]!;
  clock.mockReturnValue(now + 3_599_999);
  const existing = await reportPost(accepted.id, reporter.headers, { reason: "other" });
  expect(existing.status).toBe(200);
  expect(await existing.json()).toEqual({ message: "通報を受け付けています。" });
  expect(
    await db
      .prepare("SELECT reported_at_ms,reason FROM board_reports WHERE post_id=?")
      .bind(accepted.id)
      .all(),
  ).toMatchObject({ results: [{ reported_at_ms: now, reason: "abuse" }] });
  expect((await send(blocked.id)).status).toBe(429);
  clock.mockReturnValue(now + 3_600_000);
  expect((await send(blocked.id)).status).toBe(201);
  expect(await db.prepare("SELECT COUNT(*) AS count FROM board_reports").first("count")).toBe(6);
});

test("ゲスト統合では掲示板の通報を統合先へ移し、重複と直近1時間の上限を引き継ぐ", async () => {
  const clock = fixTestTime();
  const now = Date.now();
  const reporter = await guest();
  const author = await accountFixture();
  const reported = Array.from({ length: 5 }, () => boardPostFixture({ accountId: author.id }));
  const duplicate = reported[0]!;
  const extra = boardPostFixture({ accountId: author.id });
  await db.batch([...reported.map(({ statement }) => statement), extra.statement]);
  for (const { id } of reported) expect((await reportPost(id, reporter.headers)).status).toBe(201);

  const { target, headers } = await link(reporter);
  expect((await reportPost(duplicate.id, target.headers, { reason: "spam" })).status).toBe(201);
  const targetReport = db
    .prepare(
      "SELECT id,reported_at_ms,reason,author_account_id FROM board_reports WHERE post_id=? AND reporter_account_id=?",
    )
    .bind(duplicate.id, target.id);
  const original = await targetReport.first();
  await db
    .prepare("UPDATE board_reports SET reported_at_ms=? WHERE post_id=? AND reporter_account_id=?")
    .bind(now - 3_600_000, duplicate.id, target.id)
    .run();
  expect((await request("/account/guest-merge", { method: "POST", headers })).status).toBe(200);

  expect(await targetReport.first()).toEqual({
    ...original,
    reported_at_ms: now,
    reason: "spam",
    author_account_id: author.id,
  });
  expect(
    await db
      .prepare("SELECT id FROM board_reports WHERE reporter_account_id=?")
      .bind(reporter.id)
      .first(),
  ).toBeNull();

  for (const { id } of reported) expect((await reportPost(id, target.headers)).status).toBe(200);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM board_reports WHERE reporter_account_id=?")
      .bind(target.id)
      .first("count"),
  ).toBe(5);
  expect((await reportPost(extra.id, target.headers)).status).toBe(429);
  clock.mockReturnValue(now + 3_600_000);
  expect((await reportPost(extra.id, target.headers)).status).toBe(201);
});

test("本人削除後も管理者の証拠を7日保持し、期限後は残っている行を新しい通報で置換できる", async () => {
  const now = Date.now();
  const cutoff = now - 7 * 86400000;
  const clock = fixTestTime(now);
  const author = await accountFixture();
  const admin = await accountFixture();
  const second = await accountFixture();
  const removed = boardPostFixture({ accountId: author.id });
  const live = boardPostFixture({ accountId: author.id });
  await db.batch([removed.statement, live.statement]);
  for (const { id } of [removed, live])
    expect((await reportPost(id, admin.headers)).status).toBe(201);
  const old = (await boardAdminPage(admin)).reports.find(({ postId }) => postId === live.id)!;
  await db
    .prepare("UPDATE board_reports SET reported_at_ms=?")
    .bind(cutoff + 1)
    .run();
  expect((await reportPost(live.id, second.headers)).status).toBe(201);
  expect(
    (await boardRequest(postPath(removed.id), { method: "DELETE", headers: author.headers }))
      .status,
  ).toBe(204);
  const page = await boardAdminPage(admin);
  expect(page.reports[0]).toMatchObject({ postId: live.id, reportCount: 2 });
  expect(page.reports.find(({ postId }) => postId === removed.id)).toMatchObject({
    text: removed.text,
    postDeleted: true,
  });
  expect((await reportPost(removed.id, admin.headers)).status).toBe(429);

  clock.mockReturnValue(now + 1);
  expect((await boardAdminPage(admin)).reports).toMatchObject([
    { postId: live.id, reportCount: 1 },
  ]);
  expect(
    await db.prepare("SELECT id FROM board_reports WHERE id=?").bind(old.id).first(),
  ).not.toBeNull();
  expect((await reportPost(live.id, admin.headers, { reason: "spam" })).status).toBe(201);
  const fresh = (await boardAdminPage(admin)).reports[0]!;
  expect(fresh).toMatchObject({ postId: live.id, reason: "spam", reportCount: 2, status: "open" });
  expect(fresh.id).not.toBe(old.id);
});

test("退会の受付で証拠の名前を隠し、完了で識別子を除き本文を保持する", async () => {
  const departing = await accountFixture();
  const admin = await accountFixture();
  const removed = boardPostFixture({ accountId: departing.id });
  const preserved = boardPostFixture({ accountId: admin.id });
  await db.batch([removed.statement, preserved.statement]);
  expect((await reportPost(removed.id, admin.headers)).status).toBe(201);
  expect((await reportPost(preserved.id, departing.headers)).status).toBe(201);
  expect(await requestDeletion(env, departing.id, crypto.randomUUID())).toBe(true);
  const pending = await boardAdminPage(admin);
  expect(pending.reports.find(({ postId }) => postId === removed.id)).toMatchObject({
    authorName: "退会したプレイヤー",
    authorWithdrawn: true,
    postDeleted: true,
    text: removed.text,
  });
  expect(pending.reports.find(({ postId }) => postId === preserved.id)?.authorWithdrawn).toBe(
    false,
  );
  const stopped = await boardAdminRequest(admin.id, {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ action: "stop", postId: removed.id, stopped: true }),
  });
  expect(stopped.status).toBe(404);

  await db.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(departing.id).run();
  await processFixtureDeletion(departing.id);
  expect(
    (await boardAdminPage(admin)).reports.find(({ postId }) => postId === removed.id),
  ).toMatchObject({ authorWithdrawn: true, postDeleted: true });
  const evidence = (id: string) =>
    db
      .prepare(
        "SELECT author_account_id,reporter_account_id,author_name,body FROM board_reports WHERE post_id=?",
      )
      .bind(id)
      .first();
  expect(await evidence(removed.id)).toEqual({
    author_account_id: null,
    reporter_account_id: admin.id,
    author_name: "退会したプレイヤー",
    body: removed.text,
  });
  expect(await evidence(preserved.id)).toEqual({
    author_account_id: admin.id,
    reporter_account_id: null,
    author_name: "登録名",
    body: preserved.text,
  });
});
