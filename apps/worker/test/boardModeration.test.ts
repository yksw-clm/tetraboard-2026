import { env } from "cloudflare:workers";
import type { BoardModeration } from "@tetraboard/protocol/board";
import { tournamentChatSchema } from "@tetraboard/protocol/general-lobby";
import { afterEach, expect, test } from "vitest";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { accountFixture, origin } from "./accountFixtures";
import {
  boardAdminPage,
  boardAdminRequest,
  boardPath,
  boardPostFixture,
  boardRequest,
  detail,
  postNumber,
  postPath,
  repliesPath,
  reportPost,
  resetBoard,
  sendBoardPost,
  timeline,
} from "./boardFixtures";
import { fixTestTime } from "./fixedTimeFixture";
import { processFixtureDeletion } from "./privacyFixtures";

import { publishedChatTournament } from "./tournamentChatFixtures";

const db = env.APP_DB;
type Account = Awaited<ReturnType<typeof accountFixture>>;
afterEach(resetBoard);

function operate(admin: Account, input: BoardModeration) {
  return boardAdminRequest(admin.id, {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify(input),
  });
}

async function change(admin: Account, input: BoardModeration) {
  const response = await operate(admin, input);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ message: "変更しました。" });
}

test("管理APIで管理者認証・Origin・入力を照合し、公開APIには通報を含めない", async () => {
  const admin = await accountFixture();
  const user = await accountFixture();
  const post = boardPostFixture({ accountId: admin.id });
  await post.statement.run();
  expect((await reportPost(post.id, user.headers, { reason: "personalInfo" })).status).toBe(201);

  for (const method of ["GET", "POST"]) {
    for (const [headers, status] of [
      [{ Origin: origin }, 401],
      [user.headers, 403],
    ] as const) {
      const response = await boardAdminRequest(admin.id, { method, headers });
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  }
  expect(
    (
      await boardAdminRequest(admin.id, {
        method: "POST",
        headers: { Cookie: admin.cookie },
      })
    ).status,
  ).toBe(403);
  const invalid = await boardAdminRequest(admin.id, {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ action: "accepting", accepting: true, extra: 1 }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ message: "操作内容が正しくありません。" });

  const list = await boardAdminPage(admin);
  const report = list.reports[0]!;
  expect(report).toMatchObject({ postId: post.id, reason: "personalInfo", status: "open" });
  expect(JSON.stringify(list)).not.toContain(user.id);
  await change(admin, { action: "resolve", reportId: report.id });
  expect((await boardAdminPage(admin)).reports[0]?.status).toBe("resolved");
  const publicViews = JSON.stringify([await timeline(), await detail(post.id)]);
  for (const evidence of [report.id, user.id, "reports", "reporter", "personalInfo"])
    expect(publicViews).not.toContain(evidence);
});

test("運営削除を次の取得に反映し、返信のある枠と再送情報を維持する", async () => {
  const admin = await accountFixture();
  const author = await accountFixture();
  const sole = boardPostFixture({ accountId: author.id });
  const root = boardPostFixture({ accountId: author.id });
  const reply = boardPostFixture({ accountId: author.id, parentId: root.id });
  await db.batch([sole.statement, root.statement, reply.statement]);
  await db
    .prepare("UPDATE board_posts SET match_id=?,position=0 WHERE id=?")
    .bind(crypto.randomUUID(), root.id)
    .run();
  expect((await reportPost(root.id, admin.headers)).status).toBe(201);
  expect((await operate(admin, { action: "delete", postId: crypto.randomUUID() })).status).toBe(
    404,
  );
  await change(admin, { action: "delete", postNumber: await postNumber(sole.id) });
  await change(admin, { action: "delete", postId: root.id });
  expect((await boardRequest(postPath(sole.id))).status).toBe(404);
  expect((await timeline()).posts).toEqual([
    {
      id: root.id,
      publicNumber: await postNumber(root.id),
      postedAtMs: root.postedAtMs,
      gameId: "reversi",
      replyCount: 1,
      status: "deleted",
    },
  ]);
  expect((await detail(root.id)).replies).toMatchObject([{ id: reply.id }]);
  const replies = await boardRequest(repliesPath(root.id));
  expect(await replies.json()).toMatchObject({ replies: [{ id: reply.id }] });
  const read = () =>
    db
      .prepare(
        "SELECT body,match_id,position,request_id,body_hash,deleted_at_ms,deletion_reason FROM board_posts WHERE id=?",
      )
      .bind(root.id)
      .first();
  const deleted = await read();
  expect(deleted).toEqual({
    body: null,
    match_id: null,
    position: null,
    request_id: expect.any(String),
    body_hash: "fixture",
    deleted_at_ms: expect.any(Number),
    deletion_reason: "moderator",
  });
  await change(admin, { action: "delete", postId: root.id });
  expect(await read()).toEqual(deleted);
  expect((await boardAdminPage(admin)).reports[0]).toMatchObject({
    postDeleted: true,
    authorWithdrawn: false,
    text: root.text,
  });
  await change(admin, { action: "delete", postId: reply.id });
  expect((await boardRequest(postPath(root.id))).status).toBe(404);
  expect((await boardRequest(repliesPath(root.id))).status).toBe(404);
  expect((await timeline()).posts).toEqual([]);
});

test("運営削除を期限内の通報に記録し、投稿者が退会しても証拠に残す", async () => {
  fixTestTime();
  const now = Date.now();
  const admin = await accountFixture();
  const author = await accountFixture();
  const other = await accountFixture();
  const post = boardPostFixture({ accountId: author.id });
  await post.statement.run();

  expect((await reportPost(post.id, admin.headers, { reason: "spam" })).status).toBe(201);
  const expired = (await boardAdminPage(admin)).reports[0]!;
  await db
    .prepare("UPDATE board_reports SET reported_at_ms=? WHERE id=?")
    .bind(now - 7 * 86400000, expired.id)
    .run();
  expect((await reportPost(post.id, admin.headers)).status).toBe(201);
  expect((await reportPost(post.id, other.headers, { reason: "personalInfo" })).status).toBe(201);
  const resolved = (await boardAdminPage(admin)).reports.find(
    ({ reason }) => reason === "personalInfo",
  )!;
  await change(admin, { action: "resolve", reportId: resolved.id });
  await change(admin, { action: "delete", postId: post.id });

  const readReports = async () => (await boardAdminPage(admin)).reports;
  const reports = await readReports();
  expect(reports).toHaveLength(2);
  expect(reports).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "abuse", status: "open", moderatorDeletedAtMs: now }),
      expect.objectContaining({
        reason: "personalInfo",
        status: "resolved",
        moderatorDeletedAtMs: now,
      }),
    ]),
  );
  expect(
    await db
      .prepare("SELECT moderator_deleted_at_ms FROM board_reports WHERE id=?")
      .bind(expired.id)
      .first(),
  ).toEqual({ moderator_deleted_at_ms: null });

  expect(await requestDeletion(env, author.id, crypto.randomUUID())).toBe(true);
  await processFixtureDeletion(author.id);
  expect(
    await db
      .prepare("SELECT deletion_reason,account_id FROM board_posts WHERE id=?")
      .bind(post.id)
      .first(),
  ).toEqual({ deletion_reason: "withdrawn", account_id: null });
  expect(await readReports()).toEqual(
    reports.map((report) => ({
      ...report,
      authorName: "退会したプレイヤー",
      authorWithdrawn: true,
    })),
  );
});

test.each(["author", "withdrawn", "moderator"] as const)(
  "既に削除済みの投稿（%s）には今回の運営操作の時刻を記録しない",
  async (reason) => {
    fixTestTime();
    const admin = await accountFixture();
    const author = await accountFixture();
    const post = boardPostFixture({ accountId: author.id });
    await post.statement.run();
    expect((await reportPost(post.id, admin.headers)).status).toBe(201);

    if (reason === "author") {
      const response = await boardRequest(postPath(post.id), {
        method: "DELETE",
        headers: author.headers,
      });
      expect(response.status).toBe(204);
    } else if (reason === "withdrawn") {
      expect(await requestDeletion(env, author.id, crypto.randomUUID())).toBe(true);
    } else {
      // 同じ時刻の再送でも、今回の UPDATE で変更した行だけに記録します。
      await db
        .prepare(
          "UPDATE board_posts SET body=NULL,deleted_at_ms=?,deletion_reason='moderator' WHERE id=?",
        )
        .bind(Date.now(), post.id)
        .run();
    }

    await change(admin, { action: "delete", postId: post.id });
    expect((await boardAdminPage(admin)).reports[0]).toMatchObject({
      postId: post.id,
      postDeleted: true,
      status: "open",
      moderatorDeletedAtMs: null,
    });
  },
);

test("掲示板の投稿停止・解除と全体の受付設定は投稿と返信に反映し、大会チャットと独立する", async () => {
  const admin = await accountFixture();
  const author = await accountFixture();
  const parent = boardPostFixture({ accountId: admin.id });
  const authored = boardPostFixture({ accountId: author.id, parentId: parent.id });
  await db.batch([parent.statement, authored.statement]);
  expect((await reportPost(authored.id, admin.headers)).status).toBe(201);
  const tournament = await publishedChatTournament(db, 74202);
  const readChat = async () =>
    tournamentChatSchema.parse(
      await (
        await boardRequest(tournament.path, {
          headers: author.headers,
        })
      ).json(),
    );
  const sendToBoard = (path: string) => sendBoardPost(path, "書き込みの確認", author.headers);
  const rejectBoardWrites = async () => {
    for (const path of [boardPath, repliesPath(parent.id)])
      expect((await sendToBoard(path)).status).toBe(403);
  };
  const chatAccepting = (await readChat()).acceptingPosts;
  expect((await boardAdminPage(admin)).acceptingPosts).toBe(false);
  await rejectBoardWrites();
  await change(admin, { action: "accepting", accepting: true });
  await change(admin, { action: "stop", postId: authored.id, stopped: true });
  expect(await timeline("", author.cookie)).toMatchObject({
    acceptingPosts: true,
    postingStopped: true,
  });
  expect(await detail(parent.id, author.cookie)).toMatchObject({
    acceptingPosts: true,
    postingStopped: true,
  });
  expect(await boardAdminPage(admin)).toMatchObject({
    reports: [
      { authorStopped: true, postId: authored.id, postNumber: await postNumber(parent.id) },
    ],
    stoppedSenders: [{ accountId: author.id, name: "登録名" }],
  });
  await rejectBoardWrites();
  expect(await readChat()).toMatchObject({ postingStopped: false, acceptingPosts: chatAccepting });

  await change(admin, { action: "stop", postId: authored.id, stopped: false });
  expect((await boardAdminPage(admin)).stoppedSenders).toEqual([]);
  await change(admin, { action: "stop", postId: authored.id, stopped: true });
  await change(admin, { action: "unstop", accountId: author.id });
  expect((await detail(parent.id, author.cookie)).postingStopped).toBe(false);

  const senderId = crypto.randomUUID();
  await db
    .prepare("INSERT INTO lobby_chat_senders(account_id,public_id) VALUES(?,?)")
    .bind(author.id, senderId)
    .run();
  const chatStop = await boardRequest(
    "/admin/lobby-chat",
    {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ action: "stop", senderId, stopped: true }),
    },
    { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([admin.id]) },
  );
  expect(chatStop.status).toBe(200);
  expect((await readChat()).postingStopped).toBe(true);
  expect((await timeline("", author.cookie)).postingStopped).toBe(false);
  await change(admin, { action: "accepting", accepting: false });
  expect((await timeline()).acceptingPosts).toBe(false);
  expect((await detail(parent.id)).acceptingPosts).toBe(false);
  await rejectBoardWrites();
  await change(admin, { action: "accepting", accepting: true });
  expect((await sendToBoard(repliesPath(parent.id))).status).toBe(200);
  await db
    .prepare("UPDATE board_senders SET last_posted_at_ms=0 WHERE account_id=?")
    .bind(author.id)
    .run();
  expect((await sendToBoard(boardPath)).status).toBe(200);
  expect((await readChat()).acceptingPosts).toBe(chatAccepting);
});
