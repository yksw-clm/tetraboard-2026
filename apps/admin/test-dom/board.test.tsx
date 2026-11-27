import { expect, test } from "bun:test";
import type { BoardAdminReport, BoardModeration } from "@tetraboard/protocol/board";
import { Board } from "../src/Board";
import { enter, flush, press, render, requests } from "../../web/test-dom/support";

const postId = "11111111-1111-4111-8111-111111111111";
const replyId = "22222222-2222-4222-8222-222222222222";
const accountId = "internal-account-id";
const moderatorDeletedAtMs = Date.UTC(2026, 10, 27, 1, 2, 3);
const report: BoardAdminReport = {
  id: "33333333-3333-4333-8333-333333333333",
  postId,
  parentId: null,
  postNumber: 413,
  gameId: "reversi",
  reason: "harassment",
  authorName: "投稿者",
  text: "通報された本文",
  postedAtMs: 1,
  reportedAtMs: 2,
  status: "open",
  reportCount: 3,
  postDeleted: false,
  moderatorDeletedAtMs: null,
  authorStopped: false,
  authorWithdrawn: false,
};
const initial = {
  acceptingPosts: true,
  reports: [
    report,
    {
      ...report,
      id: "44444444-4444-4444-8444-444444444444",
      postId: replyId,
      parentId: postId,
      authorName: "退会したプレイヤー",
      authorWithdrawn: true,
      postDeleted: true,
      moderatorDeletedAtMs,
      status: "resolved",
      reason: "personalInfo",
    },
  ],
  stoppedSenders: [{ accountId, name: "停止中の投稿者" }],
};
const latest = () => requests.at(-1)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (scope: HTMLElement, name: string) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent === name);

async function respond(body: unknown, status?: number) {
  latest().respond(body, status);
  await flush();
}

async function confirm(
  scope: HTMLElement,
  label: string,
  input: BoardModeration,
  confirmation = label,
) {
  const before = requests.length;
  press(scope, label);
  expect(dialog().textContent).toContain(`選択した操作（${confirmation}）を実行しますか？`);
  expect(requests).toHaveLength(before);
  press(dialog(), "実行");
  expect(latest().url).toBe("/api/admin/board");
  expect(latest().init.method).toBe("POST");
  expect(JSON.parse(String(latest().init.body))).toEqual(input);
  expect(button(dialog(), "実行")?.disabled).toBe(true);
  await respond({ message: "変更しました。" });
  expect(latest().url).toBe("/api/admin/board");
  expect(latest().init.method).toBeUndefined();
}

test("証拠と停止中の名前を表示し、各操作を確認後に送信して一覧を再取得する", async () => {
  const view = render(<Board />);
  expect(latest().url).toBe("/api/admin/board");
  await respond(initial);
  const [row, withdrawn] = [...view.querySelectorAll("article")];
  expect(row?.textContent).toContain("晒し・嫌がらせ · 3 件 · 未対応");
  expect(row?.textContent).toContain("リバーシ · 投稿 · 投稿者");
  expect(row?.textContent).toContain("通報された本文");
  expect(row?.textContent).not.toContain("運営が削除");
  expect(withdrawn?.textContent).toContain("退会したプレイヤー");
  expect(withdrawn?.textContent).toContain("個人情報");
  expect(withdrawn?.textContent).toContain("削除済み");
  expect(withdrawn?.textContent).toContain(
    `運営が削除 ${new Date(moderatorDeletedAtMs).toLocaleString("ja")}`,
  );
  expect(withdrawn?.textContent).toContain("対応済み");
  expect(row?.querySelector("a")?.getAttribute("href")).toBe("/posts/413");
  expect(withdrawn?.querySelector("a")?.getAttribute("href")).toBe("/posts/413");
  expect(button(withdrawn!, "投稿を削除")).toBeUndefined();
  expect(button(withdrawn!, "投稿者を投稿停止")).toBeUndefined();
  expect(button(withdrawn!, "投稿停止を解除")).toBeUndefined();
  expect(button(withdrawn!, "対応済みにする")).toBeUndefined();
  expect(view.textContent).toContain("停止中の投稿者");
  expect(view.textContent).not.toContain(accountId);

  await confirm(row!, "投稿を削除", { action: "delete", postId });
  const deleted = { ...report, postDeleted: true };
  await respond({ ...initial, reports: [deleted] });
  await confirm(row!, "投稿者を投稿停止", { action: "stop", postId, stopped: true });
  await respond({ ...initial, reports: [{ ...deleted, authorStopped: true }] });
  await confirm(row!, "投稿停止を解除", { action: "stop", postId, stopped: false });
  await respond({ ...initial, reports: [deleted] });
  await confirm(view, "解除", { action: "unstop", accountId }, "投稿停止を解除");
  await respond({ ...initial, reports: [deleted], stoppedSenders: [] });
  await confirm(row!, "対応済みにする", { action: "resolve", reportId: report.id });
  await respond({ ...initial, reports: [], stoppedSenders: [] });
  expect(view.textContent).toContain("通報はありません。");
  expect(view.textContent).toContain("投稿停止中のアカウントはありません。");
  await confirm(view, "受付を停止", { action: "accepting", accepting: false });
  await respond({ ...initial, acceptingPosts: false });
  await confirm(view, "受付を再開", { action: "accepting", accepting: true });
});

test("ID 欄は不正な入力を拒否し、ID または投稿 URL から正しい操作を送信する", async () => {
  const view = render(<Board />);
  await respond({ ...initial, reports: [] });
  const field = view.querySelector("input")!;
  for (const value of [
    "invalid",
    "/posts/0",
    "https://other.example/posts/413",
    "/posts/9007199254740992",
    `/posts/${postId}/replies`,
    `https://[invalid]/posts/${postId}`,
  ]) {
    enter(field, value);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(button(view, "削除")?.disabled).toBe(true);
    expect(button(view, "投稿者を投稿停止")?.disabled).toBe(true);
    press(view, "削除");
  }
  expect(requests).toHaveLength(1);

  enter(field, postId);
  await confirm(view, "削除", { action: "delete", postId }, "投稿を削除");
  await respond({ ...initial, reports: [] });
  enter(field, `${window.location.origin}/posts/413?ref=board`);
  await confirm(view, "削除", { action: "delete", postNumber: 413 }, "投稿を削除");
  await respond({ ...initial, reports: [] });
  enter(field, `${window.location.origin}/posts/${replyId}?ref=board`);
  await confirm(view, "投稿者を投稿停止", { action: "stop", postId: replyId, stopped: true });
});
