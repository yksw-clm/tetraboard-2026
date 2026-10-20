import { expect, test } from "bun:test";
import { useGeneralLobbyRooms } from "../src/features/lobby/useGeneralLobbyRooms";
import { useLobbyChat } from "../src/features/lobby/useLobbyChat";
import { GeneralLobbyRooms } from "../src/features/lobby/GeneralLobbyRooms";
import { GeneralLobbyChat } from "../src/features/lobby/GeneralLobbyChat";
import { clock, flush, requests, renderHook, act, render, wrap, press, enter } from "./harness";
import { profile } from "../test/fixtures/account";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { useLocation } from "react-router";
import { MemoryRouter } from "react-router";
import { useState } from "react";
import type { AccountProfile } from "@tetraboard/protocol";
import { AccountContext } from "../src/features/account/useAccount";
import { guestProfile } from "./guestAccountFixtures";
const room = {
  id: "12345",
  instanceId: "11111111-1111-4111-8111-111111111111",
  game: "four-reversi" as const,
  mode: "singles" as const,
  timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
  status: "waiting" as const,
  hostName: "募集者",
  humanCount: 4,
  cpuCount: 0,
  capacity: 4,
  openSeats: 0,
  updatedAtMs: 1,
};
const message = {
  id: "11111111-1111-4111-8111-111111111111",
  senderId: "public-sender",
  senderName: "募集者",
  avatarUrl: null,
  text: "今夜遊びませんか",
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
};
function visibility(value: string) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
test("自動更新中は空表示とカードを保持し、手動更新だけ一覧のスピナーを表示", async () => {
  visibility("visible");
  function Page() {
    const page = useGeneralLobbyRooms();
    return <GeneralLobbyRooms page={page} onRoomAction={() => {}} />;
  }
  const view = render(wrap()(<Page />));
  clock.advance(0);
  requests.at(-1)!.respond({ rooms: [], nextCursor: null });
  await flush();
  const empty = view.querySelector("h3")!;
  clock.advance(10000);
  expect(view.querySelector("h3")).toBe(empty);
  expect(view.querySelector('[role="status"]')).toBeNull();
  requests.at(-1)!.respond({ rooms: [room], nextCursor: null });
  await flush();
  const card = view.querySelector<HTMLLIElement>('ul[aria-label="公開ルーム一覧"] li')!;
  expect(card.querySelector('a[href="/games/four-reversi"]')?.textContent).toBe("四人リバーシ");
  clock.advance(10000);
  expect(view.querySelector("li")).toBe(card);
  expect(view.querySelector('[role="status"]')).toBeNull();
  requests.at(-1)!.respond({ rooms: [room], nextCursor: null });
  await flush();
  press(view, "更新");
  expect(
    view.querySelector('[role="status"][aria-label="公開ルームを更新しています"]'),
  ).not.toBeNull();
  expect(view.querySelector("li")).toBe(card);
  requests.at(-1)!.respond({ message: "更新失敗" }, 503);
  await flush();
  expect(view.querySelector("li")).toBe(card);
  expect(view.querySelector('[role="status"]')).toBeNull();
});
test("空一覧のゲームボタンは定員別に分け、作成意図とともにロビーへ移動", async () => {
  function Page() {
    const page = useGeneralLobbyRooms();
    const location = useLocation();
    return (
      <>
        <GeneralLobbyRooms page={page} onRoomAction={() => {}} />
        <output>{JSON.stringify({ path: location.pathname, state: location.state })}</output>
      </>
    );
  }
  const view = render(wrap()(<Page />));
  clock.advance(0);
  requests.at(-1)!.respond({ rooms: [], nextCursor: null });
  await flush();
  for (const game of gameIds) {
    const group = view.querySelector(
      `[role="group"][aria-label="${gameCatalog[game].capacity}人プレイ"]`,
    )!;
    const link = group.querySelector<HTMLAnchorElement>(
      `a[href="${gameCatalog[game].lobbyPath}"]`,
    )!;
    expect(link.textContent).toBe(gameCatalog[game].name);
    act(() => link.click());
    await flush();
    expect(JSON.parse(view.querySelector("output")!.textContent!)).toEqual({
      path: gameCatalog[game].lobbyPath,
      state: { roomEntryIntent: "create" },
    });
  }
});
test("満室の参加は表示・無効、定員フィルターと取得失敗は既存一覧を保つ", async () => {
  function Page() {
    const page = useGeneralLobbyRooms();
    return <GeneralLobbyRooms page={page} onRoomAction={() => {}} />;
  }
  const view = render(wrap()(<Page />));
  clock.advance(0);
  requests[0].respond({ rooms: [room], nextCursor: null });
  await flush();
  const join = view.querySelector<HTMLButtonElement>('button[aria-label="ルーム 12345 に参加"]');
  expect(join).not.toBeNull();
  expect(join!.disabled).toBe(true);
  press(view, "二人");
  clock.advance(0);
  expect(requests.at(-1)!.url).toContain("capacity=2");
  requests.at(-1)!.respond({ rooms: [], nextCursor: null });
  await flush();
  expect(view.textContent).toContain("二人用の公開ルームはありません");
});
test("ルームは非表示中に取得を止め、復帰・追加取得後の更新でもページを維持する", async () => {
  visibility("visible");
  const hook = renderHook(() => useGeneralLobbyRooms(), undefined);
  clock.advance(0);
  requests[0].respond({ rooms: [room], nextCursor: "0:1:12345" });
  await flush();
  act(() => void hook.current.loadMore());
  requests.at(-1)!.respond({ rooms: [{ ...room, id: "23456" }], nextCursor: null });
  await flush();
  expect(hook.current.rooms).toHaveLength(2);
  visibility("hidden");
  const count = requests.length;
  clock.advance(20000);
  expect(requests).toHaveLength(count);
  visibility("visible");
  requests.at(-1)!.respond({ rooms: [room], nextCursor: "0:1:12345" });
  await flush();
  requests.at(-1)!.respond({ rooms: [{ ...room, id: "23456" }], nextCursor: null });
  await flush();
  expect(hook.current.rooms).toHaveLength(2);
  visibility("visible");
  requests.at(-1)!.respond({ message: "失敗しました" }, 503);
  await flush();
  expect(hook.current.rooms).toHaveLength(2);
  expect(hook.current.error).toBe("失敗しました");
});
test("チャットの投稿失敗後は同じリクエストIDで再送し、確定後に履歴を更新する", async () => {
  visibility("visible");
  const hook = renderHook(() => useLobbyChat("player"), undefined);
  clock.advance(0);
  requests[0].respond(chat);
  await flush();
  let result: Promise<boolean>;
  act(() => {
    result = hook.current.send("約束");
  });
  const first = JSON.parse(String(requests.at(-1)!.init.body));
  requests.at(-1)!.reject(new Error("通信失敗"));
  await flush();
  expect(await result!).toBe(false);
  act(() => {
    result = hook.current.send("約束");
  });
  expect(JSON.parse(String(requests.at(-1)!.init.body)).requestId).toBe(first.requestId);
  requests.at(-1)!.respond({
    message: { ...message, own: true, text: "約束" },
    availableAtMs: Date.now() + 10000,
  });
  await flush();
  expect(requests.at(-1)!.url).toContain("/lobby/chat?limit=");
  requests.at(-1)!.respond(chat);
  await flush();
  expect(await result!).toBe(true);
});
test("チャットは5秒更新し、本人切替後の古い投稿応答を画面へ適用しない", async () => {
  visibility("visible");
  const hook = renderHook((id: string) => useLobbyChat(id), "first");
  clock.advance(0);
  requests[0].respond(chat);
  await flush();
  clock.advance(5000);
  requests.at(-1)!.respond(chat);
  await flush();
  let sent: Promise<boolean>;
  act(() => {
    sent = hook.current.send("古い本人の本文");
  });
  const old = requests.at(-1)!;
  hook.rerender("second");
  clock.advance(0);
  requests.at(-1)!.respond({ ...chat, messages: [] });
  await flush();
  old.respond({ message: { ...message, own: true }, availableAtMs: Date.now() + 10000 });
  await flush();
  expect(await sent!).toBe(false);
  expect(hook.current.messages).toHaveLength(0);
});
test("ゲストは名前の確定前に作成せず、Cookie保存不能時は投稿せず入力を保持する", async () => {
  const view = render(wrap()(<GeneralLobbyChat />));
  clock.advance(0);
  requests[0]!.respond(chat);
  await flush();
  press(view, "名前を設定して投稿");
  await flush();
  expect(requests).toHaveLength(1);
  act(() =>
    document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="閉じる"]')!.click(),
  );
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(requests).toHaveLength(1);
  press(view, "名前を設定して投稿");
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  enter(dialog.querySelector<HTMLInputElement>("input")!, "投稿者");
  press(dialog, "この名前でチャットを始める");
  requests[1]!.respond({ user: null });
  await flush();
  expect(requests[2]!.url).toBe("/api/account/guest");
  requests[2]!.respond(guestProfile("投稿者"), 201);
  await flush();
  requests[3]!.respond({ user: null });
  await flush();
  expect(dialog.querySelector('[role="alert"]')!.textContent).toContain("Cookie");
  expect(dialog.querySelector<HTMLInputElement>("input")!.value).toBe("投稿者");
  expect(requests.some((r) => r.url === "/api/lobby/chat" && r.init.method === "POST")).toBe(false);
});
test("名前を設定したゲストはログインを挟まず投稿でき、下書きと認証済み本人を保持する", async () => {
  sessionStorage.setItem("tetraboard:lobby-chat:draft", "募集の下書き");
  function GuestChat() {
    const [user, update] = useState<AccountProfile | null>(null);
    return (
      <MemoryRouter>
        <AccountContext.Provider
          value={{ user, update, loading: false, error: null, refresh: async () => {} }}
        >
          <GeneralLobbyChat />
        </AccountContext.Provider>
      </MemoryRouter>
    );
  }
  const view = render(<GuestChat />);
  clock.advance(0);
  requests[0]!.respond(chat);
  await flush();
  press(view, "名前を設定して投稿");
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  enter(dialog.querySelector<HTMLInputElement>("input")!, "投稿者");
  press(dialog, "この名前でチャットを始める");
  requests[1]!.respond({ user: null });
  await flush();
  requests[2]!.respond(guestProfile("投稿者"), 201);
  await flush();
  requests[3]!.respond({ user: guestProfile("投稿者") });
  await flush();
  clock.advance(0);
  requests[4]!.respond(chat);
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(view.querySelector<HTMLInputElement>("input")!.value).toBe("募集の下書き");
  press(view, "送信");
  expect(requests[5]!.url).toBe("/api/lobby/chat");
  expect(JSON.parse(String(requests[5]!.init.body))).toMatchObject({ text: "募集の下書き" });
  requests[5]!.respond({ message: { ...message, own: true }, availableAtMs: Date.now() + 10000 });
  await flush();
  requests[6]!.respond({ ...chat, messages: [{ ...message, own: true }] });
  await flush();
  expect(view.querySelector<HTMLInputElement>("input")!.value).toBe("");
  expect(requests.filter((r) => r.url === "/api/account/guest")).toHaveLength(1);
});
test("投稿欄は失敗時に本文を保持し、送信者非表示を公開IDで端末へ保存する", async () => {
  visibility("visible");
  const view = render(wrap(profile)(<GeneralLobbyChat />));
  clock.advance(0);
  requests[0].respond(chat);
  await flush();
  const input = view.querySelector<HTMLInputElement>("input")!;
  enter(input, "明日の募集");
  press(view, "送信");
  requests.at(-1)!.respond({ message: "送信できません" }, 503);
  await flush();
  expect(input.value).toBe("明日の募集");
  expect(sessionStorage.getItem("tetraboard:lobby-chat:draft")).toBe("明日の募集");
  act(() =>
    view.querySelector<HTMLButtonElement>('button[aria-label="募集者の発言の操作"]')!.click(),
  );
  press(view, "この人の発言を非表示");
  expect(localStorage.getItem("tetraboard:lobby-chat:hidden")).toContain("public-sender");
  expect(view.textContent).toContain("この人の発言を非表示中");
});
