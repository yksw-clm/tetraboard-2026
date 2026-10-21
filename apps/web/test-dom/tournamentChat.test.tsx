import { expect, test } from "bun:test";
import { LobbyChat } from "../src/features/lobby/LobbyChat";
import { useLobbyChat } from "../src/features/lobby/useLobbyChat";
import {
  clock,
  flush,
  requests,
  render,
  renderHook,
  rerender,
  wrap,
  act,
  press,
  enter,
} from "./harness";
import { profile } from "../test/fixtures/account";
import { guestProfile } from "./guestAccountFixtures";
const message = {
  id: "11111111-1111-4111-8111-111111111111",
  senderId: "public",
  senderName: "参加者",
  avatarUrl: null,
  text: "よろしくお願いします",
  sentAtMs: 1790899200000,
  own: false,
};
const chat = {
  messages: [message],
  nextCursor: null,
  acceptingPosts: true,
  postingStopped: false,
  availableAtMs: 0,
  serverTimeMs: 1790899200000,
  entered: true,
  closesAtMs: null,
};
const options = { id: 1, onEnter: () => {}, entryAvailable: true, entryDisabled: false };
function currentGet() {
  return requests.filter((r) => r.url.includes("/chat?") && !r.init.signal?.aborted).at(-1)!;
}
async function respond(body: unknown = chat) {
  currentGet().respond(body);
  await flush();
}

test("閲覧者にはエントリー導線を表示し、閉会後の未参加者には閲覧だけを許可する", async () => {
  let entries = 0;
  const view = render(
    wrap(null)(<LobbyChat tournament={{ ...options, onEnter: () => entries++ }} />),
  );
  clock.advance(0);
  await respond({ ...chat, entered: false });
  expect(view.textContent).toContain("よろしくお願いします");
  expect(view.querySelector("input")).toBeNull();
  press(view, "エントリーして投稿");
  expect(entries).toBe(1);
  expect(requests.some((r) => r.init.method === "POST")).toBe(false);
  rerender(view, wrap(null)(<LobbyChat tournament={{ ...options, entryAvailable: false }} />));
  expect(view.textContent).toContain("投稿にはこの大会へのエントリーが必要です。");
  expect(
    [...view.querySelectorAll("button")].some((b) => b.textContent === "エントリーして投稿"),
  ).toBe(false);
});

test("名前設定済みゲストの参加者も投稿でき、失敗時の入力と同じIDを保持して再送する", async () => {
  const view = render(wrap(guestProfile())(<LobbyChat tournament={options} />));
  clock.advance(0);
  await respond();
  const input = view.querySelector("input")!;
  enter(input, "おつかれさまでした");
  press(view, "送信");
  await flush();
  const sent = requests.filter((r) => r.init.method === "POST").at(-1)!;
  expect(sent.url).toBe("/api/tournaments/1/chat");
  const body = JSON.parse(String(sent.init.body));
  sent.respond({ message: "送信失敗" }, 503);
  await flush();
  expect(input.value).toBe("おつかれさまでした");
  press(view, "送信");
  await flush();
  const retry = requests.filter((r) => r.init.method === "POST").at(-1)!;
  expect(JSON.parse(String(retry.init.body))).toEqual(body);
  retry.respond({ message: null, availableAtMs: Date.now() + 10000 });
  await flush();
  await respond();
  expect(input.value).toBe("");
});

test("大会別の下書きを保持し、別大会の入力と混ぜない", async () => {
  const screen = (id: number) =>
    wrap(profile)(<LobbyChat key={id} tournament={{ ...options, id }} />);
  const view = render(screen(1));
  clock.advance(0);
  await respond();
  enter(view.querySelector("input")!, "大会1の下書き");
  rerender(view, screen(2));
  clock.advance(0);
  await respond();
  expect(view.querySelector("input")!.value).toBe("");
  enter(view.querySelector("input")!, "大会2の下書き");
  rerender(view, screen(1));
  clock.advance(0);
  await respond();
  expect(view.querySelector("input")!.value).toBe("大会1の下書き");
});

test("結果確定後も5秒更新し、サーバー時刻に基づく締切で投稿欄を閉じる", async () => {
  const view = render(
    wrap(profile)(<LobbyChat tournament={{ ...options, entryAvailable: false }} />),
  );
  clock.advance(0);
  await respond({ ...chat, closesAtMs: Date.now() + 10000 });
  expect(view.querySelector("input")).not.toBeNull();
  const count = requests.length;
  clock.advance(5000);
  expect(requests.length).toBe(count + 1);
  await respond({ ...chat, serverTimeMs: Date.now(), closesAtMs: 1790899210000 });
  clock.advance(5000);
  expect(view.textContent).toContain("チャットの投稿受付は終了しました。");
  expect(view.querySelector("input")).toBeNull();
  expect(view.textContent).toContain(message.text);
});

test("大会切替時に古い応答を破棄し、非表示中は更新を止め復帰時に取得する", async () => {
  const hook = renderHook((id: number) => useLobbyChat(profile.username, id), 1);
  clock.advance(0);
  const old = currentGet();
  hook.rerender(2);
  clock.advance(0);
  await respond({ ...chat, messages: [{ ...message, text: "大会2" }] });
  old.respond({ ...chat, messages: [{ ...message, text: "大会1" }] });
  await flush();
  expect(hook.current.messages[0]!.text).toBe("大会2");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const count = requests.length;
  clock.advance(15000);
  expect(requests.length).toBe(count);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(currentGet().url).toBe("/api/tournaments/2/chat?limit=50");
});

test("送信者の非表示と通報を大会の履歴に対して操作し、IME変換中は送信しない", async () => {
  const view = render(wrap(profile)(<LobbyChat tournament={options} />));
  clock.advance(0);
  await respond();
  const input = view.querySelector("input")!;
  enter(input, "変換中");
  act(() => input.dispatchEvent(new Event("compositionstart", { bubbles: true })));
  press(view, "送信");
  expect(requests.some((r) => r.init.method === "POST")).toBe(false);
  act(() =>
    view.querySelector<HTMLButtonElement>('button[aria-label="参加者の発言の操作"]')!.click(),
  );
  press(view, "この人の発言を非表示");
  expect(view.textContent).toContain("この人の発言を非表示中");
  expect(JSON.parse(localStorage.getItem("tetraboard:lobby-chat:hidden")!)).toEqual(["public"]);
  press(view, "通報");
  press(document.body, "通報する");
  await flush();
  expect(requests.at(-1)!.url).toBe("/api/tournaments/1/chat/reports");
  requests.at(-1)!.respond({ message: "通報を受け付けました。" });
  await flush();
  expect(view.textContent).toContain("通報を受け付けました。");
});
