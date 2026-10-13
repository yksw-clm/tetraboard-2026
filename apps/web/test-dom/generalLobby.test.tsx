import { expect, test } from "bun:test";
import { useGeneralLobbyRooms } from "../src/features/lobby/useGeneralLobbyRooms";
import { useLobbyChat } from "../src/features/lobby/useLobbyChat";
import { GeneralLobbyRooms } from "../src/features/lobby/GeneralLobbyRooms";
import { GeneralLobbyChat } from "../src/features/lobby/GeneralLobbyChat";
import { clock, flush, requests, renderHook, act, render, wrap, press, enter } from "./harness";
import { profile } from "../test/fixtures/account";
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
