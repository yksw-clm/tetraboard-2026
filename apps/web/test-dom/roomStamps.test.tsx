import { afterEach, beforeEach, expect, test } from "bun:test";
import { RoomStampPicker } from "../src/features/room/RoomStampPicker";
import { RoomStampContext } from "../src/features/room/roomStampContext";
import { PlayerCard } from "../src/features/room/PlayerCard";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { useRoomStamps } from "../src/features/room/useRoomStamps";
import FourReversiRoomDetail from "../src/features/room/FourReversiRoomDetail";
import ReversiRoomDetail from "../src/features/room/ReversiRoomDetail";
import FourShogiRoomDetail from "../src/features/room/FourShogiRoomDetail";
import GomokuRoomDetail from "../src/features/room/GomokuRoomDetail";
import ShogiRoomDetail from "../src/features/room/ShogiRoomDetail";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import {
  standardWaitingRoom,
  standardPlayingRoom,
  standardInitialState,
} from "../test/fixtures/standardShogiFixtures";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import {
  membership,
  now,
  playerIds,
  token,
  waitingRoom,
  playingRoom,
} from "../test/fixtures/rooms";
import {
  reversiRoomSchema,
  gomokuRoomSchema,
  gameIds,
  roomTimeControl,
  roomStampIds,
  roomStamps,
  roomSocketContract,
  type RoomStampNotification,
  type RoomStampId,
  type Room,
  type FourReversiRoom,
} from "@tetraboard/protocol";
import { act, clock, flush, render, renderHook, rerender, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";
import { browserSettings } from "../src/shared/browserSettings";

let restoreSocket: () => void;
beforeEach(() => {
  restoreSocket = installSocket();
});
afterEach(() => restoreSocket());
const empty: string[] = [];
function reversiWaitingRoom() {
  const room = waitingRoom();
  return reversiRoomSchema.parse({
    ...room,
    settings: { game: "reversi", timeControl: roomTimeControl },
    players: room.players.slice(0, 2),
  });
}

function gomokuWaitingRoom() {
  const room = reversiWaitingRoom();
  return gomokuRoomSchema.parse({
    ...room,
    settings: { game: "gomoku", forbiddenRules: true, timeControl: roomTimeControl },
    roundId: null,
    positionRevision: 0,
  });
}

function options(room: FourReversiRoom = waitingRoom(), supported = true) {
  saveRoomMembershipToken(room.id, token);
  return {
    initialRoom: room,
    initialMembership: membership,
    initialServerNowMs: now,
    initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
    initialStampsSupported: supported,
  };
}
function connect(room: Room = waitingRoom(), availableAtMs = 0) {
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room, now + clock.now);
  socket.receive({
    type: "room.authenticated",
    membership,
    interactionAvailableAtMs: availableAtMs,
  });
  return socket;
}
function useStamps(input: ReturnType<typeof options> & { hidden?: string[] }) {
  const session = useRoomSession(input);
  const stamps = useRoomStamps(session, input.hidden ?? empty);
  return { session, stamps };
}
function notification(
  room: Room = waitingRoom(),
  stampId: RoomStampId = "cry",
  senderId = membership.playerId,
): RoomStampNotification {
  return {
    type: "room.stamp.received",
    id: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    instanceId: room.instanceId,
    senderId,
    stampId,
    sentAtMs: now + clock.now,
  };
}
function submitted(socket: Socket) {
  const message = socket.sent.findLast((entry) => entry.type === "room.stamp.send")!;
  return roomSocketContract.clientMessage.parse(message) as Extract<
    ReturnType<typeof roomSocketContract.clientMessage.parse>,
    { type: "room.stamp.send" }
  >;
}

test("表示OFFで演出を即時解除し、OFF中の通知をON後に再演せず送信は継続できる", () => {
  const room = waitingRoom();
  const h = renderHook(useStamps, options(room), wrap());
  const socket = connect(room);
  socket.receive(notification(room, "cry", playerIds[1]));
  expect(Object.keys(h.current.stamps)).toHaveLength(1);
  act(() => browserSettings.update({ stampsVisible: false }));
  expect(h.current.stamps).toEqual({});
  const hidden = notification(room, "hello", playerIds[1]);
  socket.receive(hidden);
  act(() => expect(h.current.session.sendStamp("cry")).toBe(true));
  socket.receive({ ...notification(room), requestId: submitted(socket).requestId });
  expect(h.current.stamps).toEqual({});
  act(() => browserSettings.update({ stampsVisible: true }));
  socket.receive(hidden);
  expect(h.current.stamps).toEqual({});
  socket.receive(notification(room, "like", playerIds[1]));
  expect(Object.keys(h.current.stamps)).toHaveLength(1);
  clock.advance(3000);
  expect(h.current.stamps).toEqual({});
});

test("スタンプ送信待ち・制限中でもパネルを開いて表示設定だけを変更できる", async () => {
  let sent = 0;
  const view = render(
    <RoomStampPicker
      theme="default"
      disabled={false}
      pending
      sendDisabled
      closeSignal="waiting"
      onSend={() => {
        sent++;
        return false;
      }}
    />,
  );
  act(() => view.querySelector<HTMLButtonElement>('[aria-label="スタンプを送る"]')!.click());
  await flush();
  const panel = document.querySelector('[aria-label="スタンプを選択"]')!;
  expect(panel.querySelectorAll("button[data-stamp-id]:disabled")).toHaveLength(6);
  act(() => panel.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(browserSettings.getSnapshot().stampsVisible).toBe(false);
  expect(document.querySelector('[aria-label="スタンプを選択"]')).not.toBeNull();
  expect(sent).toBe(0);
});

test("受理通知後だけ3秒表示し、他タブのrequestIdでは待ちを解除しない。重複で延長しない", () => {
  const room = waitingRoom(),
    h = renderHook(useStamps, options(room), wrap());
  const socket = connect(room);
  expect(socket.url).toContain("&stamps=1");
  act(() => {
    expect(h.current.session.sendStamp("cry")).toBe(true);
  });
  expect(h.current.stamps).toEqual({});
  expect(h.current.session.pendingStamp).toBe(true);
  const otherTab = notification(room);
  socket.receive(otherTab);
  expect(h.current.session.pendingStamp).toBe(true);
  const accepted = { ...notification(room), requestId: submitted(socket).requestId };
  socket.receive(accepted);
  expect(h.current.session.pendingStamp).toBe(false);
  expect(h.current.stamps[membership.playerId]).toEqual(accepted);
  clock.advance(2999);
  socket.receive(accepted);
  expect(h.current.stamps[membership.playerId]).toEqual(accepted);
  clock.advance(1);
  expect(h.current.stamps).toEqual({});
  expect(h.current.session.interactionReady).toBe(true);
  expect(h.current.session.chatMessages).toEqual([]);
});
test("置換は新しい3秒、複数人は独立。非表示対象・席削除・次局で解除する", () => {
  const room = waitingRoom(),
    props = options(room),
    h = renderHook(useStamps, props, wrap());
  const socket = connect(room);
  socket.receive(notification(room, "cry", playerIds[1]));
  clock.advance(2000);
  socket.receive(notification(room, "hello", playerIds[1]));
  socket.receive(notification(room, "like", playerIds[2]));
  clock.advance(1000);
  expect(Object.keys(h.current.stamps)).toHaveLength(2);
  h.rerender({ ...props, hidden: [playerIds[1]!] });
  expect(h.current.stamps[playerIds[1]!]).toBeUndefined();
  socket.receive(notification(room, "cry", playerIds[1]));
  expect(h.current.stamps[playerIds[1]!]).toBeUndefined();
  const fewer = { ...room, players: room.players.filter((player) => player.id !== playerIds[2]) };
  socket.snapshot(fewer, now + clock.now);
  expect(h.current.stamps).toEqual({});
  socket.receive(notification(room));
  expect(Object.keys(h.current.stamps)).toHaveLength(1);
  socket.snapshot(playingRoom(), now + clock.now);
  expect(h.current.stamps).toEqual({});
});
test("送信制限はチャット・スタンプで共有し、認証とrate_limited応答から復元する", () => {
  const room = waitingRoom(),
    h = renderHook(useStamps, options(room), wrap()),
    socket = connect(room, now + 3000);
  expect(h.current.session.interactionReady).toBe(false);
  act(() => expect(h.current.session.sendStamp("cry")).toBe(false));
  clock.advance(3000);
  act(() => expect(h.current.session.sendChat("こんにちは")).toBe(true));
  socket.receive({
    type: "room.chat.snapshot",
    messages: [
      {
        kind: "player",
        id: crypto.randomUUID(),
        senderId: membership.playerId,
        senderName: "本人",
        text: "こんにちは",
        sentAtMs: now + clock.now,
      },
    ],
  });
  expect(h.current.session.interactionReady).toBe(false);
  clock.advance(3000);
  act(() => h.current.session.sendStamp("cry"));
  const sent = submitted(socket);
  act(() => h.current.session.handleReadyClick());
  socket.receive({ type: "room.stamp.error", requestId: crypto.randomUUID(), error: "muted" });
  expect(h.current.session.pendingStamp).toBe(true);
  socket.receive({
    type: "room.stamp.error",
    requestId: sent.requestId,
    error: "rate_limited",
    interactionAvailableAtMs: now + clock.now + 2000,
  });
  expect(h.current.session.pendingStamp).toBe(false);
  expect(h.current.session.pendingReady).toBe(true);
  expect(h.current.session.stampError).toContain("3秒");
  expect(h.current.session.interactionReady).toBe(false);
  expect(h.current.stamps).toEqual({});
  clock.advance(2000);
  expect(h.current.session.interactionReady).toBe(true);
});
test("スタンプの送信待ちでも準備でき、無関係な通知で期限を延長せず10秒で復旧する", () => {
  const room = waitingRoom(),
    h = renderHook(useStamps, options(room), wrap()),
    socket = connect(room);
  act(() => {
    h.current.session.sendStamp("cry");
    h.current.session.handleReadyClick();
  });
  expect(h.current.session.pendingReady).toBe(true);
  clock.advance(9999);
  socket.receive(notification(room, "hello", playerIds[1]));
  expect(h.current.session.pendingStamp).toBe(true);
  clock.advance(1);
  expect(h.current.session.pendingStamp).toBe(false);
  expect(h.current.session.connection).toBe("再接続中");
  expect(h.current.stamps).toEqual({});
  expect(socket.sent.filter((message) => message.type === "room.stamp.send")).toHaveLength(1);
});
test("非表示・切断で演出を破棄し、復帰時の通知や古い接続を再演しない", async () => {
  const room = waitingRoom(),
    h = renderHook(useStamps, options(room), wrap()),
    socket = connect(room);
  socket.receive(notification(room));
  expect(Object.keys(h.current.stamps)).toHaveLength(1);
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(h.current.stamps).toEqual({});
  socket.receive(notification(room));
  expect(h.current.stamps).toEqual({});
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  socket.receive(notification(room));
  expect(h.current.stamps).toEqual({});
  requests.at(-1)!.respond({
    room,
    presence: { hostPlayerId: playerIds[0], connectedPlayerIds: playerIds },
    serverNowMs: now + clock.now,
    stampsSupported: true,
  });
  await flush();
  requests.at(-1)!.respond(membership);
  await flush();
  socket.receive({ type: "room.authenticated", membership, interactionAvailableAtMs: 0 });
  socket.receive(notification(room));
  expect(h.current.stamps).toEqual({});
  clock.advance(1);
  socket.receive(notification(room));
  expect(Object.keys(h.current.stamps)).toHaveLength(1);
  act(() => socket.close());
  expect(h.current.stamps).toEqual({});
  socket.receive(notification(room));
  expect(h.current.stamps).toEqual({});
  if (original) Object.defineProperty(document, "visibilityState", original);
  else Reflect.deleteProperty(document, "visibilityState");
});
test("旧Workerへの再接続ではスタンプ入口を無効化し、旧通信で通常操作を継続する", async () => {
  const room = waitingRoom(),
    h = renderHook(useStamps, options(room), wrap()),
    socket = connect(room);
  act(() => socket.close());
  clock.advance(1000);
  requests.at(-1)!.respond({
    room,
    presence: { hostPlayerId: playerIds[0], connectedPlayerIds: playerIds },
    serverNowMs: now + clock.now,
  });
  await flush();
  requests.at(-1)!.respond(membership);
  await flush();
  const next = connect(room);
  expect(next.url).not.toContain("stamps=1");
  expect(h.current.session.stampsSupported).toBe(false);
  act(() => {
    expect(h.current.session.sendStamp("cry")).toBe(false);
    h.current.session.handleReadyClick();
  });
  expect(next.sent.at(-1)?.type).toBe("room.ready.set");
});
test("アバターを再マウントせず枠内に重ね、Context外の棋譜には表示しない", () => {
  const room = waitingRoom(),
    stamp = notification(room);
  const card = (
    <PlayerCard
      player={room.players[0]!}
      room={room}
      self
      host
      connected
      now={now}
      position="bottom"
    />
  );
  const view = render(<RoomStampContext.Provider value={{}}>{card}</RoomStampContext.Provider>);
  const avatar = view.querySelector('[data-testid="player-avatar"]');
  rerender(
    view,
    <RoomStampContext.Provider value={{ [membership.playerId]: stamp }}>
      {card}
    </RoomStampContext.Provider>,
  );
  expect(view.querySelector('[data-testid="player-avatar"]')).toBe(avatar);
  expect(view.querySelector('[data-testid="player-stamp"]')?.textContent).toContain("😭");
  expect(view.querySelector('[aria-label="接続中"]')).not.toBeNull();
  rerender(view, card);
  expect(view.querySelector('[data-testid="player-stamp"]')).toBeNull();
});
test("選択パネルは6候補、選択とEscと外側フォーカスと閉鎖指示で閉じる", async () => {
  const sent: RoomStampId[] = [];
  const picker = (signal = "waiting") => (
    <RoomStampPicker
      disabled={false}
      pending={false}
      closeSignal={signal}
      theme="default"
      onSend={(id) => {
        sent.push(id);
        return true;
      }}
    />
  );
  const view = render(<main tabIndex={-1}>{picker()}</main>);
  const trigger = view.querySelector<HTMLButtonElement>('button[aria-label="スタンプを送る"]')!;
  act(() => trigger.click());
  await flush();
  clock.advance(32);
  expect(document.querySelector('[aria-label="スタンプを選択"]')).not.toBeNull();
  expect(document.querySelectorAll('[aria-label="スタンプを選択"] [data-stamp-id]')).toHaveLength(
    6,
  );
  for (const id of roomStampIds) {
    const candidate = document.querySelector(`[data-stamp-id="${id}"]`)!;
    expect(candidate.textContent).toBe(roomStamps[id].emoji);
    expect(candidate.getAttribute("aria-label")).toBe(roomStamps[id].name);
  }
  // ネイティブクリックはpressより先にトリガーへフォーカスを移します。
  act(() => trigger.focus());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  act(() => trigger.click());
  await flush();
  clock.advance(32);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  act(() => trigger.click());
  await flush();
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="泣く"]')!.click());
  await flush();
  clock.advance(32);
  expect(sent).toEqual(["cry"]);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  act(() => trigger.click());
  await flush();
  clock.advance(32);
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await flush();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  act(() => trigger.click());
  await flush();
  const outside = document.createElement("button");
  document.body.append(outside);
  act(() => outside.focus());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  outside.remove();
  act(() => trigger.click());
  await flush();
  act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  act(() => trigger.click());
  await flush();
  rerender(view, <main tabIndex={-1}>{picker("my-turn")}</main>);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
test("観戦の盤面回転後も送信者IDに対応したカードへ表示する", async () => {
  const room = playingRoom();
  const view = render(
    wrap()(<FourReversiRoomDetail {...options(room)} initialMembership={null} invited={false} />),
  );
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive(notification(room, "cry", playerIds[1]));
  const before = view
    .querySelector('[data-testid="player-stamp"]')!
    .closest('[data-testid="player-card"]')!;
  const label = before.getAttribute("aria-label");
  const position = before.className;
  act(() =>
    view.querySelector<HTMLButtonElement>('[aria-label="盤面を時計回りに90度回転"]')!.click(),
  );
  const after = view
    .querySelector('[data-testid="player-stamp"]')!
    .closest('[data-testid="player-card"]')!;
  expect(after.getAttribute("aria-label")).toBe(label);
  expect(after.className).not.toBe(position);
  expect(view.querySelectorAll('[data-testid="player-stamp"]')).toHaveLength(1);
  await flush();
});

test("通常将棋の投了・持将棋・入玉宣言はスタンプ応答待ちでも利用できる", async () => {
  const state = standardInitialState();
  const board = state.board.map((row) =>
    row.map(() => null),
  ) as (typeof state.board)[number][number][][];
  board[1]![4] = { id: 1, side: "south", kind: "king", promoted: false };
  board[8]![8] = { id: 2, side: "north", kind: "king", promoted: false };
  const room = standardPlayingRoom({ ...state, board, turn: "south" });
  const view = render(
    wrap()(<ShogiRoomDetail {...options()} initialRoom={room} invited={false} />),
  );
  const socket = connect(room);
  act(() => view.querySelector<HTMLButtonElement>('[aria-label="スタンプを送る"]')!.click());
  await flush();
  clock.advance(32);
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="泣く"]')!.click());
  expect(submitted(socket).stampId).toBe("cry");
  for (const name of ["投了", "持将棋提案", "入玉宣言"]) {
    const button = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === name,
    )!;
    expect(button).toBeDefined();
    expect(button.disabled).toBe(false);
  }
});

for (const game of gameIds)
  test(`${game}: 共通入口から送信し、本人カードに表示してもチャット履歴を追加しない`, async () => {
    const room =
      game === "four-reversi"
        ? waitingRoom()
        : game === "four-shogi"
          ? waitingShogiRoom()
          : game === "reversi"
            ? reversiWaitingRoom()
            : game === "gomoku"
              ? gomokuWaitingRoom()
              : standardWaitingRoom();
    saveRoomMembershipToken(room.id, token);
    const common = {
      initialMembership: membership,
      initialServerNowMs: now,
      initialPresence: {
        hostPlayerId: playerIds[0]!,
        connectedPlayerIds: room.players.map((p) => p.id),
      },
      initialStampsSupported: true,
      invited: false,
    };
    const node =
      game === "four-reversi" ? (
        <FourReversiRoomDetail {...common} initialRoom={waitingRoom()} />
      ) : game === "four-shogi" ? (
        <FourShogiRoomDetail {...common} initialRoom={waitingShogiRoom()} />
      ) : game === "reversi" ? (
        <ReversiRoomDetail {...common} initialRoom={reversiWaitingRoom()} />
      ) : game === "gomoku" ? (
        <GomokuRoomDetail {...common} initialRoom={gomokuWaitingRoom()} />
      ) : (
        <ShogiRoomDetail {...common} initialRoom={standardWaitingRoom()} />
      );
    const view = render(wrap()(node));
    const socket = Socket.instances.at(-1)!;
    socket.open();
    socket.snapshot(room);
    socket.receive({ type: "room.authenticated", membership, interactionAvailableAtMs: 0 });
    act(() =>
      view.querySelector<HTMLButtonElement>('button[aria-label="スタンプを送る"]')!.click(),
    );
    await flush();
    clock.advance(32);
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="泣く"]')!.click());
    expect(view.querySelector('[data-testid="player-stamp"]')).toBeNull();
    const sent = submitted(socket);
    socket.receive({
      type: "room.stamp.received",
      id: crypto.randomUUID(),
      instanceId: room.instanceId,
      requestId: sent.requestId,
      senderId: membership.playerId,
      stampId: "cry",
      sentAtMs: now + clock.now,
    });
    expect(view.querySelector('[data-testid="player-stamp"]')?.textContent).toContain("😭");
    expect(view.querySelector('[aria-label="チャット履歴"]')?.textContent).toContain(
      "まだメッセージはありません",
    );
    expect(roomStampIds).toHaveLength(6);
    act(() =>
      [...view.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((tab) => tab.textContent?.includes("ルーム"))!
        .click(),
    );
    await flush();
    act(() => view.querySelector<HTMLButtonElement>('[aria-label="表示・サウンド設定"]')!.click());
    await flush();
    const settings = document.querySelector('[data-slot="modal-dialog"][role="dialog"]')!;
    expect(settings.textContent).toContain("表示・サウンド設定");
    act(() =>
      settings
        .querySelector<HTMLInputElement>('[role="switch"][aria-label="カード上のスタンプ表示"]')!
        .click(),
    );
    expect(view.querySelector('[data-testid="player-stamp"]')).toBeNull();
    expect(browserSettings.getSnapshot().stampsVisible).toBe(false);
  });
