import { env } from "cloudflare:workers";
import {
  notificationListSchema,
  notificationSchema,
  notificationUnreadSchema,
} from "@tetraboard/protocol";
import { boardReplyResultSchema } from "@tetraboard/protocol/board";
import { markNotificationRead } from "@tetraboard/context-community";
import { afterEach, expect, test } from "vitest";
import { notificationRequestStore } from "../src/adapters/community/notifications";
import { requestDeletion } from "../src/flows/accountPurge/requestDeletion";
import { accountFixture } from "./accountFixtures";
import {
  boardAdminRequest,
  boardPostFixture,
  boardRequest,
  openBoard,
  postPath,
  repliesPath,
  resetBoard,
  sendBoardPost,
} from "./boardFixtures";

const db = env.APP_DB;
type Account = Awaited<ReturnType<typeof accountFixture>>;
const optIn = "?replies=1";
const text = "返信の一行目\n返信の二行目";
afterEach(resetBoard);

async function thread() {
  await openBoard();
  const recipient = await accountFixture();
  const author = await accountFixture();
  const parent = boardPostFixture({ accountId: recipient.id });
  await parent.statement.run();
  return { recipient, author, parent };
}

async function postReply(postId: string, author: Account, requestId?: string) {
  const response = await sendBoardPost(repliesPath(postId), text, author.headers, requestId);
  expect(response.status).toBe(200);
  const { reply } = boardReplyResultSchema.parse(await response.json());
  expect(reply).not.toBeNull();
  return reply!;
}

function get(path: string, account?: Account) {
  return boardRequest(path, { headers: account?.headers });
}

async function list(account?: Account, query = optIn) {
  const response = await get(`/notifications${query}`, account);
  expect(response.status).toBe(200);
  return notificationListSchema.parse(await response.json());
}

async function unread(account: Account, query = optIn) {
  const response = await get(`/account/notifications/unread${query}`, account);
  expect(response.status).toBe(200);
  return notificationUnreadSchema.parse(await response.json());
}

function markRead(account: Account, id: number) {
  return boardRequest("/account/notifications/read", {
    headers: account.headers,
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

test("他人の返信は親の投稿者だけに届き、現在の返信者名を表示して既読を保存できる", async () => {
  const { recipient, author, parent } = await thread();
  const before = await list(recipient);
  const beforeUnread = await unread(recipient);
  const requestId = crypto.randomUUID();
  const reply = await postReply(parent.id, author, requestId);
  expect((await postReply(parent.id, author, requestId)).id).toBe(reply.id);
  await db.prepare("UPDATE user SET name=? WHERE id=?").bind("変更後の名前", author.id).run();

  const saved = await db
    .prepare("SELECT * FROM notification_events WHERE kind='reply' AND source_id=?")
    .bind(reply.id)
    .all();
  expect(saved.results).toEqual([
    {
      seq: expect.any(Number),
      kind: "reply",
      source_id: reply.id,
      account_id: recipient.id,
      created_at_ms: reply.postedAtMs,
      payload_json: "{}",
      legacy: 0,
    },
  ]);
  const id = Number(saved.results[0]!.seq);
  const expected = {
    id,
    createdAtMs: reply.postedAtMs,
    kind: "reply",
    read: false,
    legacy: false,
    reply: {
      postId: parent.id,
      replyId: reply.id,
      gameId: "reversi",
      authorName: "変更後の名前",
      text,
    },
  };
  const page = await list(recipient);
  expect(page.notifications.filter(({ kind }) => kind === "reply")).toEqual([expected]);
  expect(page.upperBound).toBe(id);
  const detailPath = `/notifications/${id}`;
  const detail = await get(detailPath + optIn, recipient);
  expect(detail.status).toBe(200);
  expect(notificationSchema.parse(await detail.json())).toEqual(expected);
  expect(await unread(recipient)).toEqual({ hasUnread: true, upperBound: id });
  for (const viewer of [author, await accountFixture(), undefined]) {
    expect((await list(viewer)).notifications.some((n) => n.id === id)).toBe(false);
    expect((await get(detailPath + optIn, viewer)).status).toBe(404);
  }

  expect(await list(recipient, "")).toEqual(before);
  expect(await unread(recipient, "")).toEqual(beforeUnread);
  expect((await get(detailPath, recipient)).status).toBe(404);
  for (const path of ["/notifications", detailPath, "/account/notifications/unread"]) {
    expect((await get(path + "?replies=0", recipient)).status).toBe(400);
  }

  expect((await markRead(recipient, id)).status).toBe(200);
  expect((await markRead(recipient, id)).status).toBe(200);
  expect((await list(recipient)).notifications[0]).toEqual({ ...expected, read: true });
  expect(await unread(recipient)).toEqual({ hasUnread: false, upperBound: id });

  await postReply(parent.id, await accountFixture());
  const latest = await unread(recipient);
  expect(latest.hasUnread).toBe(true);
  expect(latest.upperBound).toBeGreaterThan(id);
  const readAll = await boardRequest("/account/notifications/read-all", {
    headers: recipient.headers,
    method: "POST",
    body: JSON.stringify({ through: latest.upperBound }),
  });
  expect(readAll.status).toBe(200);
  expect(await unread(recipient)).toEqual({ hasUnread: false, upperBound: latest.upperBound });
});

test("自分の投稿への返信では通知を作らない", async () => {
  const { recipient, parent } = await thread();
  const reply = await postReply(parent.id, recipient);
  expect(
    await db
      .prepare("SELECT 1 FROM notification_events WHERE kind='reply' AND source_id=?")
      .bind(reply.id)
      .first(),
  ).toBeNull();
});

test("通知の GET は未知のクエリを無視し、既知のクエリの不正値を拒否する", async () => {
  const { recipient, author, parent } = await thread();
  await postReply(parent.id, author);
  const id = (await list(recipient)).upperBound;
  for (const path of ["/notifications", `/notifications/${id}`, "/account/notifications/unread"]) {
    const current = await get(path + optIn, recipient);
    const future = await get(path + optIn + "&future=1", recipient);
    expect(current.status).toBe(200);
    expect(future.status).toBe(200);
    expect(await future.json()).toEqual(await current.json());
    expect((await get(path + "?replies=2&future=1", recipient)).status).toBe(400);
  }
  expect((await get("/notifications?cursor=abc&future=1", recipient)).status).toBe(400);
});

test.each([
  "返信者本人の削除",
  "運営による返信削除",
  "親の投稿の削除",
  "返信者の退会",
  "受取人の退会",
])("%sの後は返信通知の取得と既読保存ができない", async (action) => {
  const { recipient, author, parent } = await thread();
  const baseline = await unread(recipient);
  const reply = await postReply(parent.id, author);
  const { upperBound: id } = await unread(recipient);
  expect(id).toBeGreaterThan(baseline.upperBound);
  switch (action) {
    case "返信者本人の削除":
      expect(
        (await boardRequest(postPath(reply.id), { method: "DELETE", headers: author.headers }))
          .status,
      ).toBe(204);
      break;
    case "運営による返信削除": {
      const admin = await accountFixture();
      const response = await boardAdminRequest(admin.id, {
        method: "POST",
        headers: admin.headers,
        body: JSON.stringify({ action: "delete", postId: reply.id }),
      });
      expect(response.status).toBe(200);
      break;
    }
    case "親の投稿の削除":
      expect(
        (await boardRequest(postPath(parent.id), { method: "DELETE", headers: recipient.headers }))
          .status,
      ).toBe(204);
      break;
    case "返信者の退会":
      expect(await requestDeletion(env, author.id, crypto.randomUUID())).toBe(true);
      break;
    case "受取人の退会":
      expect(await requestDeletion(env, recipient.id, crypto.randomUUID())).toBe(true);
      break;
  }
  const page = await list(recipient);
  expect(page.notifications.some((n) => n.id === id)).toBe(false);
  expect(page.upperBound).toBe(baseline.upperBound);
  expect((await get(`/notifications/${id}${optIn}`, recipient)).status).toBe(404);
  if (action === "受取人の退会") {
    // 退会受付後は認証が失効する。本人確認直後に退会した場合の D1 の判定も確かめる。
    expect((await get(`/account/notifications/unread${optIn}`, recipient)).status).toBe(401);
    expect((await markRead(recipient, id)).status).toBe(401);
    const store = notificationRequestStore(db);
    expect(await store.list(recipient.id, { id, includeReplies: true })).toEqual([]);
    expect(await store.hasUnread(recipient.id, true)).toBe(false);
    expect(await store.upperBound(recipient.id, true)).toBe(baseline.upperBound);
    expect(await markNotificationRead(store, recipient.id, id)).toBe(false);
  } else {
    expect(await unread(recipient)).toEqual(baseline);
    expect((await markRead(recipient, id)).status).toBe(404);
  }
});
