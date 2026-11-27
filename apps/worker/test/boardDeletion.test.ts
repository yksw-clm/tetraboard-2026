import { env } from "cloudflare:workers";
import { postToBoard, type BoardDestination } from "@tetraboard/context-community";
import { boardPostResultSchema } from "@tetraboard/protocol/board";
import { afterEach, expect, test } from "vitest";
import { setBoardLike } from "../src/adapters/community/boardActions";
import { D1BoardWriter } from "../src/adapters/community/boardPosting";
import { digest } from "../src/crypto";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { accountFixture } from "./accountFixtures";
import {
  boardPath,
  boardPostFixture,
  boardRequest,
  detail,
  likePath,
  openBoard,
  postNumber,
  postPath,
  repliesPath,
  resetBoard,
  sendBoardPost,
  timeline,
} from "./boardFixtures";
import { processFixtureDeletion } from "./privacyFixtures";

const db = env.APP_DB;
afterEach(resetBoard);

async function putLike(postId: string, headers: HeadersInit) {
  const response = await boardRequest(likePath(postId), { method: "PUT", headers });
  expect(response.status).toBe(200);
}

async function finishDeletion(accountId: string) {
  await db.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(accountId).run();
  await processFixtureDeletion(accountId);
  const deletion = await db
    .prepare("SELECT completed_at_ms FROM deleted_accounts WHERE id=?")
    .bind(accountId)
    .first<{ completed_at_ms: number | null }>();
  expect(deletion?.completed_at_ms).toBeGreaterThan(0);
}

test("退会受付で投稿と返信の本文・添付・再送情報を消していいねを除き、完了で本人参照を外す", async () => {
  await openBoard();
  const departing = await accountFixture();
  const remaining = await accountFixture();
  const avatarId = crypto.randomUUID();
  await db
    .prepare("UPDATE user SET name=?,avatarKey=? WHERE id=?")
    .bind("退会する登録者", `avatars/${avatarId}.webp`, departing.id)
    .run();
  const requestId = crypto.randomUUID();
  const text = "退会で消える元の投稿";
  const sent = await sendBoardPost(boardPath, text, departing.headers, requestId);
  expect(sent.status).toBe(200);
  const { post } = boardPostResultSchema.parse(await sent.json());
  const parentId = post!.id;
  const unthreaded = boardPostFixture({ accountId: departing.id, text: "退会で消える単独投稿" });
  const alreadyRemoved = boardPostFixture({ accountId: departing.id });
  const survives = boardPostFixture({ accountId: remaining.id });
  const survivesReply = boardPostFixture({ accountId: remaining.id, parentId });
  const departingReply = boardPostFixture({
    accountId: departing.id,
    parentId: survives.id,
    text: "退会で消える返信",
  });
  await db.batch([
    unthreaded.statement,
    alreadyRemoved.statement,
    survives.statement,
    survivesReply.statement,
    departingReply.statement,
    db
      .prepare("UPDATE board_posts SET match_id=?,position=0 WHERE account_id=?")
      .bind(crypto.randomUUID(), departing.id),
  ]);
  expect(
    (
      await boardRequest(postPath(alreadyRemoved.id), {
        method: "DELETE",
        headers: departing.headers,
      })
    ).status,
  ).toBe(204);
  const removedAt = await db
    .prepare("SELECT deleted_at_ms FROM board_posts WHERE id=?")
    .bind(alreadyRemoved.id)
    .first<number>("deleted_at_ms");
  expect(removedAt).toEqual(expect.any(Number));
  await putLike(survives.id, departing.headers);
  await putLike(survives.id, remaining.headers);
  expect((await detail(survives.id)).post).toMatchObject({ replyCount: 1, likeCount: 2 });
  expect((await detail(parentId)).post).toMatchObject({
    text,
    author: { name: "退会する登録者", avatarUrl: `/api/avatars/${avatarId}` },
  });

  expect(await requestDeletion(env, departing.id, crypto.randomUUID())).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT body,match_id,position,request_id,body_hash,deletion_reason,deleted_at_ms,typeof(deleted_at_ms) AS deleted_at_type FROM board_posts WHERE account_id=?",
      )
      .bind(departing.id)
      .all()
      .then(({ results }) => results),
  ).toEqual(
    Array.from({ length: 4 }, () => ({
      body: null,
      match_id: null,
      position: null,
      request_id: null,
      body_hash: null,
      deletion_reason: "withdrawn",
      deleted_at_ms: expect.any(Number),
      deleted_at_type: "integer",
    })),
  );
  expect(
    await db
      .prepare("SELECT deleted_at_ms FROM board_posts WHERE id=?")
      .bind(alreadyRemoved.id)
      .first<number>("deleted_at_ms"),
  ).toBe(removedAt);
  expect(
    await db.prepare("SELECT 1 FROM board_likes WHERE account_id=?").bind(departing.id).first(),
  ).toBeNull();
  expect((await timeline()).posts.map(({ id }) => id).sort()).toEqual(
    [parentId, survives.id].sort(),
  );
  expect((await boardRequest(postPath(unthreaded.id))).status).toBe(404);
  const placeholder = await detail(parentId);
  expect(placeholder.post).toEqual({
    status: "deleted",
    id: parentId,
    publicNumber: post!.publicNumber,
    gameId: "reversi",
    postedAtMs: post!.postedAtMs,
    replyCount: 1,
  });
  expect(placeholder.replies.map(({ id }) => id)).toEqual([survivesReply.id]);
  const thread = await detail(survives.id);
  expect(thread.post).toMatchObject({ status: "published", likeCount: 1, replyCount: 0 });
  expect(thread.replies).toEqual([]);
  for (const privateValue of [
    text,
    unthreaded.text,
    departingReply.text,
    "退会する登録者",
    avatarId,
  ])
    expect(JSON.stringify([placeholder, thread])).not.toContain(privateValue);

  // 本人確認の直後に退会した要求も、D1の書き込み条件と再送の照合で拒否します。
  const writer = new D1BoardWriter(db, async () => false);
  const write = (destination: BoardDestination, retryId: string) =>
    postToBoard(
      writer,
      { ...destination, accountId: departing.id, requestId: retryId, text },
      Date.now,
      digest,
    );
  const root = { gameId: "reversi", parentId: null } as const;
  expect(await write(root, requestId)).toEqual({ status: "ineligible" });
  expect(await write(root, crypto.randomUUID())).toEqual({ status: "ineligible" });
  expect(await write({ gameId: null, parentId: survives.id }, crypto.randomUUID())).toEqual({
    status: "ineligible",
  });
  expect(await setBoardLike(db, departing.id, survives.id, true, Date.now)).toEqual({
    status: "ineligible",
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM board_posts WHERE account_id=?")
      .bind(departing.id)
      .first(),
  ).toEqual({ count: 4 });
  expect(
    await db.prepare("SELECT 1 FROM board_likes WHERE account_id=?").bind(departing.id).first(),
  ).toBeNull();
  expect((await sendBoardPost(boardPath, text, departing.headers, requestId)).status).toBe(401);

  expect((await sendBoardPost(repliesPath(survives.id), text, departing.headers)).status).toBe(401);
  expect(
    (
      await boardRequest(likePath(survives.id), {
        method: "PUT",
        headers: departing.headers,
      })
    ).status,
  ).toBe(401);

  await finishDeletion(departing.id);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM board_posts WHERE account_id=?")
      .bind(departing.id)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await db
      .prepare("SELECT account_id,body,deletion_reason FROM board_posts WHERE id=?")
      .bind(parentId)
      .first(),
  ).toEqual({ account_id: null, body: null, deletion_reason: "withdrawn" });
  expect(await write(root, crypto.randomUUID())).toEqual({ status: "ineligible" });
  expect(
    await db.prepare("SELECT 1 FROM board_senders WHERE account_id=?").bind(departing.id).first(),
  ).toBeNull();
  expect(
    await db.prepare("SELECT 1 FROM board_likes WHERE account_id=?").bind(departing.id).first(),
  ).toBeNull();
});

test("退会台帳だけが復元された場合も読み取りで隠し、毎時の再処理が本文・再送情報・いいねを消す", async () => {
  const departing = await accountFixture();
  const remaining = await accountFixture();
  const post = boardPostFixture({ accountId: departing.id, text: "復元された投稿" });
  const hidden = boardPostFixture({ accountId: departing.id, text: "復元された単独投稿" });
  const reply = boardPostFixture({ accountId: remaining.id, parentId: post.id });
  const withdrawnReply = boardPostFixture({
    accountId: departing.id,
    parentId: post.id,
    text: "復元された返信",
  });
  await db.batch([post.statement, hidden.statement, reply.statement, withdrawnReply.statement]);
  await putLike(reply.id, departing.headers);
  await db
    .prepare("INSERT INTO deleted_accounts (id,requested_at_ms,receipt_hash) VALUES(?,?,?)")
    .bind(departing.id, Date.now(), crypto.randomUUID())
    .run();

  expect(
    await db.prepare("SELECT body,deleted_at_ms FROM board_posts WHERE id=?").bind(post.id).first(),
  ).toEqual({ body: post.text, deleted_at_ms: null });
  expect((await timeline()).posts).toEqual([
    {
      status: "deleted",
      id: post.id,
      publicNumber: await postNumber(post.id),
      gameId: "reversi",
      replyCount: 1,
      postedAtMs: post.postedAtMs,
    },
  ]);
  const page = await detail(post.id);
  expect(page.replies.map(({ id, likeCount }) => ({ id, likeCount }))).toEqual([
    { id: reply.id, likeCount: 0 },
  ]);
  expect((await boardRequest(postPath(hidden.id))).status).toBe(404);

  await finishDeletion(departing.id);
  const withdrawnIds = [post.id, hidden.id, withdrawnReply.id].sort();
  expect(
    await db
      .prepare(
        "SELECT id,account_id,body,request_id,body_hash,deletion_reason FROM board_posts WHERE id IN (?,?,?) ORDER BY id",
      )
      .bind(...withdrawnIds)
      .all()
      .then(({ results }) => results),
  ).toEqual(
    withdrawnIds.map((id) => ({
      id,
      account_id: null,
      body: null,
      request_id: null,
      body_hash: null,
      deletion_reason: "withdrawn",
    })),
  );
  expect(
    await db.prepare("SELECT 1 FROM board_likes WHERE account_id=?").bind(departing.id).first(),
  ).toBeNull();
});
