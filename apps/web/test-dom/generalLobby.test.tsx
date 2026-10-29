import { expect, test } from "bun:test";
import { useGeneralLobbyRooms } from "../src/features/lobby/useGeneralLobbyRooms";
import { useLobbyChat } from "../src/features/lobby/useLobbyChat";
import { GeneralLobbyPage } from "../src/features/lobby/GeneralLobbyPage";
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
  participants: Array.from({ length: 4 }, () => ({
    kind: "human" as const,
    avatarUrl: null,
    profileTarget: null,
  })),
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
  requests.at(-1)!.respond({ rooms: [], nextCursor: null, totalCount: 0 });
  await flush();
  const empty = view.querySelector("h3")!;
  clock.advance(10000);
  expect(view.querySelector("h3")).toBe(empty);
  expect(view.querySelector('[role="status"]')).toBeNull();
  requests.at(-1)!.respond({ rooms: [room], nextCursor: null, totalCount: 1 });
  await flush();
  const card = view.querySelector<HTMLLIElement>('ul[aria-label="公開ルーム一覧"] li')!;
  expect(card.querySelector('a[href="/games/four-reversi"]')?.textContent).toBe("四人リバーシ");
  clock.advance(10000);
  expect(view.querySelector("li")).toBe(card);
  expect(view.querySelector('[role="status"]')).toBeNull();
  requests.at(-1)!.respond({ rooms: [room], nextCursor: null, totalCount: 1 });
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
test("初回失敗では空と断定せず、成功した0件表示は更新失敗でも保持する", async () => {
  visibility("visible");
  function Page() {
    const page = useGeneralLobbyRooms();
    return <GeneralLobbyRooms page={page} onRoomAction={() => {}} />;
  }
  const view = render(wrap()(<Page />));
  clock.advance(0);
  requests.at(-1)!.respond({ message: "初回失敗" }, 503);
  await flush();
  expect(view.querySelector("h3")).toBeNull();
  expect(view.querySelector('[role="status"]')).toBeNull();
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("初回失敗");
  press(view, "更新");
  requests.at(-1)!.respond({ rooms: [], nextCursor: null, totalCount: 0 });
  await flush();
  act(() => view.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const empty = view.querySelector("h3")!;
  expect(empty.textContent).toBe("参加できる公開ルームはありません");
  press(view, "更新");
  requests.at(-1)!.respond({ message: "更新失敗" }, 503);
  await flush();
  expect(view.querySelector("h3")).toBe(empty);
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("更新失敗");
  expect(view.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
});
test("ホームの全登録ゲームと作成ボタンはゲーム選択を経由し、作成意図とともにロビーへ移動", async () => {
  function Page() {
    const location = useLocation();
    return (
      <>
        <GeneralLobbyPage />
        <output>{JSON.stringify({ path: location.pathname, state: location.state })}</output>
      </>
    );
  }
  const view = render(wrap()(<Page />));
  expect(
    view.querySelector('section[aria-labelledby="game-list-title"]')!.querySelectorAll("a"),
  ).toHaveLength(gameIds.length);
  expect(view.querySelector("h1")!.textContent).toBe("TetraBoard");
  press(view, "ルームを作る");
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelectorAll("a")).toHaveLength(gameIds.length);
  for (const game of gameIds) {
    const link = dialog.querySelector<HTMLAnchorElement>(
      `a[href="${gameCatalog[game].lobbyPath}"]`,
    )!;
    act(() => link.click());
    await flush();
    expect(JSON.parse(view.querySelector("output")!.textContent!)).toEqual({
      path: gameCatalog[game].lobbyPath,
      state: { roomEntryIntent: "create" },
    });
  }
  expect(requests.some((request) => request.init.method === "POST")).toBe(false);
});
test("満室の参加は表示・無効、定員フィルターと取得失敗は既存一覧を保つ", async () => {
  function Page() {
    const page = useGeneralLobbyRooms();
    return <GeneralLobbyRooms page={page} onRoomAction={() => {}} />;
  }
  const view = render(wrap()(<Page />));
  clock.advance(0);
  requests[0].respond({ rooms: [room], nextCursor: null, totalCount: 1 });
  await flush();
  const join = view.querySelector<HTMLButtonElement>('button[aria-label="ルーム 12345 に参加"]');
  expect(join).not.toBeNull();
  expect(join!.disabled).toBe(true);
  press(view, "二人用");
  clock.advance(0);
  expect(requests.at(-1)!.url).toContain("capacity=2");
  requests.at(-1)!.respond({ rooms: [], nextCursor: null, totalCount: 0 });
  await flush();
  expect(view.textContent).toContain("二人用の公開ルームはありません");
});
test("全件取得は非表示で中断し、復帰時は先頭から読み直して古い途中応答を破棄する", async () => {
  visibility("visible");
  const hook = renderHook(() => useGeneralLobbyRooms(), undefined);
  clock.advance(0);
  requests[0].respond({ rooms: [room], nextCursor: "0:1:12345", totalCount: 2 });
  await flush();
  const interrupted = requests[1]!;
  expect(hook.current.rooms).toHaveLength(0);
  visibility("hidden");
  expect(interrupted.init.signal?.aborted).toBe(true);
  const count = requests.length;
  clock.advance(20000);
  expect(requests).toHaveLength(count);
  visibility("visible");
  expect(requests.at(-1)!.url).not.toContain("cursor=");
  interrupted.respond({ rooms: [{ ...room, id: "23456" }], nextCursor: null, totalCount: 2 });
  await flush();
  expect(hook.current.rooms).toHaveLength(0);
  requests.at(-1)!.respond({ rooms: [room], nextCursor: "0:1:12345", totalCount: 2 });
  await flush();
  requests.at(-1)!.respond({ rooms: [{ ...room, id: "23456" }], nextCursor: null, totalCount: 2 });
  await flush();
  expect(hook.current.rooms).toHaveLength(2);
  visibility("visible");
  requests.at(-1)!.respond({ message: "失敗しました" }, 503);
  await flush();
  expect(hook.current.rooms).toHaveLength(2);
  expect(hook.current.error).toBe("失敗しました");
});
test("総合の定員変更は途中の全件取得を中断し、新しい定員だけを取り直す", async () => {
  visibility("visible");
  const hook = renderHook(() => useGeneralLobbyRooms(), undefined);
  clock.advance(0);
  requests[0]!.respond({ rooms: [room], nextCursor: "0:1:12345", totalCount: 2 });
  await flush();
  const old = requests[1]!;
  act(() => {
    hook.current.changeJoinable(true);
    hook.current.changeCapacity(2);
  });
  expect(old.init.signal?.aborted).toBe(true);
  clock.advance(0);
  const current = requests.at(-1)!;
  expect(current.url).toContain("capacity=2");
  expect(current.url).not.toContain("joinable=");
  old.respond({ rooms: [room], nextCursor: null, totalCount: 2 });
  await flush();
  expect(hook.current.rooms).toHaveLength(0);
  current.respond({
    rooms: [
      {
        ...room,
        id: "23456",
        game: "reversi",
        mode: undefined,
        capacity: 2,
        humanCount: 1,
        openSeats: 1,
        participants: [room.participants[0]],
      },
    ],
    nextCursor: null,
    totalCount: 1,
  });
  await flush();
  expect(hook.current.rooms.map((entry) => entry.id)).toEqual(["23456"]);
  expect(hook.current.totalCount).toBe(1);
  expect(hook.current.joinable).toBe(true);
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
