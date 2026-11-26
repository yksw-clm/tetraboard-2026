import { env } from "cloudflare:workers";
import type { BoardModeration } from "@tetraboard/protocol/board";
import { lobbyChatSchema } from "@tetraboard/protocol/general-lobby";
import { afterEach, expect, test } from "vitest";
import { accountFixture, origin } from "./accountFixtures";
import {
  boardAdminPage,
  boardAdminRequest,
  boardPath,
  boardPostFixture,
  boardRequest,
  detail,
  postPath,
  repliesPath,
  reportPost,
  resetBoard,
  sendBoardPost,
  timeline,
} from "./boardFixtures";

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
  await change(admin, { action: "delete", postId: sole.id });
  await change(admin, { action: "delete", postId: root.id });
  expect((await boardRequest(postPath(sole.id))).status).toBe(404);
  expect((await timeline()).posts).toEqual([
    {
      id: root.id,
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

test("掲示板の投稿停止・解除と全体の受付設定は投稿と返信に反映し、公開チャットと独立する", async () => {
  const admin = await accountFixture();
  const author = await accountFixture();
  const parent = boardPostFixture({ accountId: admin.id });
  const authored = boardPostFixture({ accountId: author.id, parentId: parent.id });
  await db.batch([parent.statement, authored.statement]);
  expect((await reportPost(authored.id, admin.headers)).status).toBe(201);
  const readChat = async () =>
    lobbyChatSchema.parse(
      await (
        await boardRequest("/lobby/chat", {
          headers: author.headers,
        })
      ).json(),
    );
  const sendToBoard = (path: string) => sendBoardPost(path, "書き込みの確認", author.headers);
  const rejectBoardWrites = async () => {
    for (const path of [boardPath, repliesPath(parent.id)])
      expect((await sendToBoard(path)).status).toBe(403);
  };
  const lobbyAccepting = (await readChat()).acceptingPosts;
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
    reports: [{ authorStopped: true }],
    stoppedSenders: [{ accountId: author.id, name: "登録名" }],
  });
  await rejectBoardWrites();
  expect(await readChat()).toMatchObject({ postingStopped: false, acceptingPosts: lobbyAccepting });

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
  expect((await readChat()).acceptingPosts).toBe(lobbyAccepting);
});
