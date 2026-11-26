import { env } from "cloudflare:workers";
import { boardPostVisibility } from "@tetraboard/context-community";
import { boardLikeResultSchema, boardRepliesSchema } from "@tetraboard/protocol/board";
import { afterEach, expect, test } from "vitest";
import { accountFixture, origin } from "./accountFixtures";
import {
  boardPath,
  boardPostFixture,
  boardRequest,
  detail,
  likePath,
  openBoard,
  postPath,
  repliesPath,
  resetBoard,
  sendBoardPost,
  timeline,
} from "./boardFixtures";

afterEach(resetBoard);

test("タイムラインはゲームごとに投稿日時とIDの降順で、返信によって順番を変えない", async () => {
  const { id: accountId } = await accountFixture();
  const now = Date.now();
  const posts = Array.from({ length: 24 }, (_, i) =>
    boardPostFixture({ accountId, postedAtMs: now - Math.floor(i / 3), text: `投稿 ${i}` }),
  );
  const oldest = posts.at(-1)!;
  await env.APP_DB.batch([
    ...posts.map(({ statement }) => statement),
    boardPostFixture({ accountId, parentId: oldest.id, postedAtMs: now + 1, text: "返信本文" })
      .statement,
    boardPostFixture({ accountId, gameId: "shogi", postedAtMs: now + 2 }).statement,
  ]);
  const sorted = posts.toSorted((a, b) => b.postedAtMs - a.postedAtMs || b.id.localeCompare(a.id));
  const page = await timeline();
  expect(page.posts.map(({ id }) => id)).toEqual(sorted.slice(0, 20).map(({ id }) => id));
  expect(page.nextCursor).toBe(`${sorted[19]!.postedAtMs}:${sorted[19]!.id}`);
  const next = await timeline(`?before=${page.nextCursor}`);
  expect(next.posts.map(({ id }) => id)).toEqual(sorted.slice(20).map(({ id }) => id));
  expect(next.posts.find(({ id }) => id === oldest.id)).toMatchObject({
    status: "published",
    text: oldest.text,
    replyCount: 1,
  });
  expect(JSON.stringify(next)).not.toContain("返信本文");
  expect(next.nextCursor).toBeNull();
  expect((await timeline("?limit=3")).posts.map(({ id }) => id)).toEqual(
    sorted.slice(0, 3).map(({ id }) => id),
  );
});

test("詳細は削除済みの返信を除き、返信を日時とIDの昇順で50件ずつ返す", async () => {
  const user = await accountFixture();
  const parent = boardPostFixture({ accountId: user.id });
  const replies = Array.from({ length: 103 }, (_, i) =>
    boardPostFixture({
      accountId: user.id,
      parentId: parent.id,
      postedAtMs: parent.postedAtMs + 1 + Math.floor(i / 3),
      text: `返信 ${i}`,
    }),
  );
  await env.APP_DB.batch([parent.statement, ...replies.map(({ statement }) => statement)]);
  for (const reply of replies.slice(0, 3))
    expect(
      (await boardRequest(postPath(reply.id), { method: "DELETE", headers: user.headers })).status,
    ).toBe(204);
  const sorted = replies
    .slice(3)
    .sort((a, b) => a.postedAtMs - b.postedAtMs || a.id.localeCompare(b.id));

  const first = await detail(parent.id, user.cookie);
  expect(first.post).toMatchObject({ replyCount: 100, text: parent.text, own: true });
  expect(first).toMatchObject({ acceptingPosts: false, postingStopped: false, availableAtMs: 0 });
  expect(first.serverTimeMs).toBeGreaterThanOrEqual(parent.postedAtMs);
  expect(first.replies.map(({ id }) => id)).toEqual(sorted.slice(0, 50).map(({ id }) => id));
  expect(first.replies[0]?.text).toBe(sorted[0]?.text);
  expect(first.nextCursor).toBe(`${sorted[49]!.postedAtMs}:${sorted[49]!.id}`);

  const response = await boardRequest(`${repliesPath(parent.id)}?after=${first.nextCursor}`);
  expect(response.status).toBe(200);
  const second = boardRepliesSchema.parse(await response.json());
  expect(second.replies.map(({ id }) => id)).toEqual(sorted.slice(50).map(({ id }) => id));
  expect(second.nextCursor).toBeNull();
  expect((await boardRequest(postPath(replies[4]!.id))).status).toBe(404);
  expect((await boardRequest(repliesPath(replies[4]!.id))).status).toBe(404);
});

test("取得条件の不正は 400、読み取り失敗は no-store の 503", async () => {
  const id = crypto.randomUUID();
  for (const path of [
    boardPath + "?limit=0",
    boardPath + "?limit=21",
    boardPath + "?limit=3.5",
    boardPath + "?limit=1&limit=2",
    boardPath + "?before=invalid",
    boardPath + `?before=9007199254740992:${id}`,
    repliesPath(id) + "?after=invalid",
  ])
    expect((await boardRequest(path)).status, path).toBe(400);
  const db = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "batch") return () => Promise.reject(new Error("D1 unavailable"));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await boardRequest(postPath(id), undefined, { ...env, APP_DB: db });
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    message: "掲示板を処理できませんでした。もう一度お試しください。",
  });
});

test("本人削除は冪等で、SQLのタイムラインと詳細は返信数に応じた公開判定に従う", async () => {
  await openBoard();
  const author = await accountFixture();
  const reader = await accountFixture();
  const noReplies = boardPostFixture({ accountId: author.id });
  const parent = boardPostFixture({ accountId: author.id });
  const reply = boardPostFixture({ accountId: reader.id, parentId: parent.id });
  await env.APP_DB.batch([noReplies.statement, parent.statement, reply.statement]);
  expect(
    (
      await boardRequest(postPath(parent.id), {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
  ).toBe(401);
  expect(
    (await boardRequest(postPath(parent.id), { method: "DELETE", headers: reader.headers })).status,
  ).toBe(404);

  const remove = (id: string, headers: HeadersInit) =>
    boardRequest(postPath(id), { method: "DELETE", headers });
  expect((await remove(noReplies.id, author.headers)).status).toBe(204);
  expect((await remove(parent.id, author.headers)).status).toBe(204);
  const deleted = await env.APP_DB.prepare(
    "SELECT deleted_at_ms,deletion_reason FROM board_posts WHERE id=?",
  )
    .bind(parent.id)
    .first<{ deleted_at_ms: number; deletion_reason: string }>();
  expect(deleted?.deletion_reason).toBe("author");
  expect((await remove(parent.id, author.headers)).status).toBe(204);
  expect(
    await env.APP_DB.prepare("SELECT deleted_at_ms,deletion_reason FROM board_posts WHERE id=?")
      .bind(parent.id)
      .first(),
  ).toEqual(deleted);

  const removed = deleted!.deleted_at_ms;
  expect(boardPostVisibility(removed, 0)).toBe("notFound");
  expect(boardPostVisibility(removed, 1)).toBe("placeholder");
  const placeholder = {
    status: "deleted",
    id: parent.id,
    gameId: "reversi",
    postedAtMs: parent.postedAtMs,
    replyCount: 1,
  };
  expect((await timeline()).posts).toEqual([placeholder]);
  expect((await detail(parent.id)).post).toEqual(placeholder);
  expect((await detail(parent.id)).replies.map(({ id }) => id)).toEqual([reply.id]);
  expect((await boardRequest(repliesPath(parent.id))).status).toBe(200);
  await expectMissingThread(noReplies.id);
  expect((await sendBoardPost(repliesPath(parent.id), "返信", reader.headers)).status).toBe(404);
  expect(
    (await boardRequest(likePath(parent.id), { method: "PUT", headers: reader.headers })).status,
  ).toBe(404);
  expect(
    (await boardRequest(likePath(reply.id), { method: "PUT", headers: reader.headers })).status,
  ).toBe(200);

  expect((await remove(reply.id, reader.headers)).status).toBe(204);
  expect((await timeline()).posts).toEqual([]);
  await expectMissingThread(parent.id);
});

async function expectMissingThread(id: string) {
  for (const path of [postPath(id), repliesPath(id)]) {
    const response = await boardRequest(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
}

test("いいねを本人にも返信にも付けられ、重複せず、閲覧者ごとに表示して取り消せる", async () => {
  const author = await accountFixture();
  const other = await accountFixture();
  const parent = boardPostFixture({ accountId: author.id });
  const reply = boardPostFixture({ accountId: other.id, parentId: parent.id });
  await env.APP_DB.batch([parent.statement, reply.statement]);

  async function like(id: string, method: "PUT" | "DELETE", headers: HeadersInit) {
    const response = await boardRequest(likePath(id), { method, headers });
    expect(response.status).toBe(200);
    return boardLikeResultSchema.parse(await response.json());
  }
  expect(await like(parent.id, "PUT", author.headers)).toEqual({ liked: true, likeCount: 1 });
  expect(await like(parent.id, "PUT", author.headers)).toEqual({ liked: true, likeCount: 1 });
  expect(await like(reply.id, "PUT", other.headers)).toEqual({ liked: true, likeCount: 1 });
  expect((await timeline("", author.cookie)).posts[0]).toMatchObject({
    own: true,
    liked: true,
    likeCount: 1,
  });
  expect((await timeline("", other.cookie)).posts[0]).toMatchObject({
    own: false,
    liked: false,
    likeCount: 1,
  });

  const page = await detail(parent.id, other.cookie);
  const profile = await env.APP_DB.prepare("SELECT publicProfileId FROM user WHERE id=?")
    .bind(author.id)
    .first<string>("publicProfileId");
  expect(page.post).toMatchObject({
    author: { name: "登録名", profileTarget: { source: "profile", profileId: profile } },
    liked: false,
    likeCount: 1,
    own: false,
  });
  expect(JSON.stringify(page)).not.toContain(author.id);
  expect(page.replies[0]).toMatchObject({ liked: true, likeCount: 1, own: true });
  expect((await detail(parent.id)).replies[0]).toMatchObject({
    liked: false,
    likeCount: 1,
    own: false,
  });
  expect(await like(parent.id, "PUT", other.headers)).toEqual({ liked: true, likeCount: 2 });
  expect(await like(parent.id, "DELETE", author.headers)).toEqual({ liked: false, likeCount: 1 });
  expect(await like(parent.id, "DELETE", author.headers)).toEqual({ liked: false, likeCount: 1 });
  expect(await like(crypto.randomUUID(), "DELETE", author.headers)).toEqual({
    liked: false,
    likeCount: 0,
  });

  expect(
    (await boardRequest(postPath(reply.id), { method: "DELETE", headers: other.headers })).status,
  ).toBe(204);
  expect(await like(reply.id, "DELETE", other.headers)).toEqual({ liked: false, likeCount: 0 });
  expect(
    await env.APP_DB.prepare("SELECT * FROM board_likes WHERE post_id=?").bind(reply.id).first(),
  ).toBeNull();
});
