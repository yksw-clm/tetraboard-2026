import { expect, test } from "bun:test";
import { LobbyChat } from "../src/LobbyChat";
import { render, requests, flush, press } from "../../web/test-dom/support";
const id = "11111111-1111-4111-8111-111111111111";
const report = {
  id,
  messageId: id,
  senderId: "public",
  senderName: "投稿者",
  text: "通報された本文",
  sentAtMs: 1,
  reportedAtMs: 2,
  status: "pending",
};
test("運営画面は通報・停止を表示し、操作失敗を残して再試行できる", async () => {
  const view = render(<LobbyChat />);
  requests
    .find((r) => r.url === "/api/admin/lobby-chat")!
    .respond({
      acceptingPosts: true,
      reports: [report],
      stoppedSenders: [{ senderId: "public", senderName: "停止中" }],
    });
  requests
    .find((r) => r.url.startsWith("/api/lobby/chat"))!
    .respond({
      messages: [],
      nextCursor: null,
      acceptingPosts: true,
      postingStopped: false,
      availableAtMs: 0,
      serverTimeMs: 1,
    });
  await flush();
  expect(view.textContent).toContain("通報された本文");
  expect(view.textContent).toContain("停止中");
  press(view, "投稿受付を停止");
  press(view, "実行");
  expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({
    action: "accepting",
    accepting: false,
  });
  requests.at(-1)!.respond({}, 503);
  await flush();
  expect(view.textContent).toContain("変更できませんでした");
  expect(view.textContent).toContain("通報された本文");
  press(view, "投稿受付を停止");
  press(view, "実行");
  requests.at(-1)!.respond({ message: "変更しました" });
  await flush();
  expect(requests.filter((r) => r.url === "/api/admin/lobby-chat").length).toBe(4);
});
test("大会管理は対象大会の履歴と通報を表示し、大会だけの受付停止を送信する", async () => {
  const view = render(<LobbyChat tournamentId={3} />);
  requests
    .find((r) => r.url === "/api/admin/lobby-chat?tournamentId=3")!
    .respond({
      acceptingPosts: true,
      reports: [{ ...report, tournamentId: 3 }],
      stoppedSenders: [],
    });
  requests
    .find((r) => r.url === "/api/tournaments/3/chat?limit=500")!
    .respond({
      messages: [],
      nextCursor: null,
      acceptingPosts: true,
      postingStopped: false,
      availableAtMs: 0,
      serverTimeMs: 1,
      entered: false,
      closesAtMs: null,
    });
  await flush();
  expect(view.textContent).toContain("大会 #3 のチャット管理");
  expect(view.querySelector('a[href="/tournaments/3"]')).not.toBeNull();
  press(view, "投稿受付を停止");
  press(view, "実行");
  expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({
    action: "accepting",
    accepting: false,
    tournamentId: 3,
  });
});
