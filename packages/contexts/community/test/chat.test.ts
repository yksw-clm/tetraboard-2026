import { expect, test } from "bun:test";
import {
  chatProfileRejection,
  lobbyRetentionMs,
  postChatMessage,
  readChatPage,
  type ChatPageRows,
  type ChatWriter,
} from "../src";

const now = 8 * 86400000;
const input = { accountId: "author", requestId: "request", tournamentId: 1, text: "発言" };
const message = (id: string, sentAtMs = now) => ({
  id,
  sentAtMs,
  text: input.text,
  senderId: "public",
  senderName: "投稿者",
  avatarUrl: null,
  own: true,
});
const openPage: ChatPageRows = {
  messages: [],
  accepting: true,
  sender: null,
  tournament: { accepting: true, finalizedAtMs: null, entered: true },
};

test("7日の取得窓とカーソルを使い、古い投稿から並べて次のカーソルを返す", async () => {
  const rows = [message("c"), message("b"), message("a", now - 1)];
  const read = await readChatPage(
    {
      async readPage(query) {
        expect(query).toEqual({
          viewer: "author",
          tournamentId: 1,
          afterMs: now - lobbyRetentionMs,
          before: { sentAtMs: now + 1, id: "d" },
          count: 3,
        });
        return { ...openPage, messages: rows };
      },
    },
    { viewer: "author", tournamentId: 1, before: `${now + 1}:d`, limit: 2 },
    () => now,
  );

  expect(read.page).toEqual({
    messages: [rows[1], rows[0]],
    nextCursor: `${now}:b`,
    acceptingPosts: true,
    postingStopped: false,
    availableAtMs: 0,
    serverTimeMs: now,
    entered: true,
    closesAtMs: null,
  });
});

test("プロフィール設定とゲスト名を投稿前に確認する", () => {
  expect(chatProfileRejection({ profileCompleted: 0 })).toBe("profileIncomplete");
  expect(chatProfileRejection({ profileCompleted: 1, isAnonymous: 1 })).toBe("guestNameRequired");
  expect(
    chatProfileRejection({ profileCompleted: 1, isAnonymous: 1, guestNameCustomized: 1 }),
  ).toBeNull();
  expect(chatProfileRejection({ profileCompleted: 1 })).toBeNull();
});

const writer: ChatWriter = {
  async insertEligiblePost() {},
  async readAcceptedPost() {
    return null;
  },
  async readMessage() {
    return null;
  },
  async readPage() {
    return openPage;
  },
};
const post = (store: ChatWriter) =>
  postChatMessage(
    store,
    input,
    () => now,
    async () => "hash",
  );

test.each([
  { page: { ...openPage, accepting: false }, status: "stopped" },
  { page: { ...openPage, sender: { stopped: true, lastSentAtMs: now - 9999 } }, status: "stopped" },
  {
    page: { ...openPage, sender: { stopped: false, lastSentAtMs: now - 9999 } },
    status: "rateLimited",
  },
  {
    page: { ...openPage, tournament: { accepting: false, entered: true, finalizedAtMs: null } },
    status: "stopped",
  },
  {
    page: { ...openPage, tournament: { accepting: false, entered: false, finalizedAtMs: null } },
    status: "entryRequired",
  },
  {
    page: {
      ...openPage,
      tournament: { accepting: false, entered: false, finalizedAtMs: now - 86400000 },
    },
    status: "closed",
  },
])("受理記録がなければ投稿状態に応じて $status を返す", async ({ page, status }) => {
  const result = await post({
    ...writer,
    async insertEligiblePost(attempt, window) {
      expect(attempt).toEqual({ ...input, sentAtMs: now, bodyHash: "hash" });
      expect(window).toEqual({
        lastPostByMs: now - 10000,
        finalizedAfterMs: now - 86400000,
        requestAfterMs: now - lobbyRetentionMs,
      });
    },
    async readPage() {
      return page;
    },
  });

  expect(result).toEqual({ status, availableAtMs: page.sender ? now + 1 : 0 });
});

test.each([
  { bodyHash: "hash", tournamentId: 1, status: "accepted" },
  { bodyHash: "other", tournamentId: 1, status: "changedReplay" },
  { bodyHash: "hash", tournamentId: null, status: "changedReplay" },
])(
  "再送IDが受理済みなら本文と大会を照合し $status を返す",
  async ({ bodyHash, tournamentId, status }) => {
    const result = await post({
      ...writer,
      async readAcceptedPost() {
        return { messageId: "deleted-message", bodyHash, tournamentId, sentAtMs: now - 1 };
      },
      async readPage() {
        throw new Error("受理済みの再送は投稿状態を読み直しません。");
      },
    });

    expect(result).toEqual(
      status === "changedReplay"
        ? { status }
        : { status, message: null, availableAtMs: now + 9999 },
    );
  },
);
