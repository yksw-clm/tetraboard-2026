import { afterEach, beforeEach, expect, test } from "bun:test";
import { useEffect, useRef, useState } from "react";
import { RoomInfo } from "../src/features/room/RoomInfo";
import { RoomSettingsDialog } from "../src/features/room/RoomSettingsDialog";
import { FourShogiRoomView } from "../src/features/room/FourShogiRoomView";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { useFourShogiRoomSession } from "../src/features/room/useFourShogiRoomSession";
import { useRoomChat } from "../src/features/room/useRoomChat";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import { waitingRoom, membership, token, now, playerIds } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { profile } from "../test/fixtures/account";
import { act, flush, press, render, wrap } from "./harness";
import { installSocket, Socket } from "./socket";

let restoreSocket: () => void;
beforeEach(() => {
  restoreSocket = installSocket();
});
afterEach(() => restoreSocket());
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
function selectMode(mode: string) {
  act(() =>
    dialog().querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!.click(),
  );
}
const commands = (socket: Socket) =>
  socket.sent.filter((message) => message.type === "room.settings.apply");
async function setup(room = waitingRoom(), user: typeof profile | null = null) {
  saveRoomMembershipToken(room.id, token);
  let session: ReturnType<typeof useRoomSession>;
  function Settings() {
    const currentSession = useRoomSession({
      initialRoom: room,
      initialMembership: membership,
      initialServerNowMs: now,
      initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
    });
    useEffect(() => {
      session = currentSession;
    }, [currentSession]);
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <>
        <RoomInfo
          session={currentSession}
          onLeave={() => {}}
          onShare={() => {}}
          onRoomSettings={() => setOpen(true)}
          roomSettingsButtonRef={ref}
          onFeedback={() => {}}
          feedbackButtonRef={ref}
        />
        {open && <RoomSettingsDialog session={currentSession} onClose={() => setOpen(false)} />}
      </>
    );
  }
  const view = render(wrap(user)(<Settings />));
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive({ type: "room.authenticated", membership });
  press(view, "ルーム設定");
  await flush();
  return { view, socket, session: () => session! };
}

test("設定はダイアログ内の下書きに保持し、キャンセル・閉じるでは送信しない", async () => {
  const { view, socket } = await setup();
  expect(dialog().textContent).toContain("2対2のチーム戦");
  expect(view.querySelector('[role="dialog"]')).toBeNull();
  selectMode("doubles");
  expect(commands(socket)).toHaveLength(0);
  press(dialog(), "キャンセル");
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  press(view, "ルーム設定");
  await flush();
  expect(dialog().querySelector<HTMLInputElement>('input[value="singles"]')!.checked).toBe(true);
  selectMode("doubles");
  act(() => dialog().querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!.click());
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(commands(socket)).toHaveLength(0);
});

test("適用は一度だけ送信し、応答待ちをロックして確定後に閉じる", async () => {
  const room = waitingRoom();
  const { socket, session } = await setup(room);
  selectMode("doubles");
  press(dialog(), "適用");
  press(dialog(), "適用");
  expect(commands(socket)).toHaveLength(1);
  expect(commands(socket)[0]).toMatchObject({
    mode: "doubles",
    timeControl: room.settings.timeControl,
    cpus: [],
  });
  expect(session().room.settings.mode).toBe("singles");
  await flush();
  expect(session().pendingSettingsCommand).not.toBeNull();
  expect(dialog().querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.disabled).toBe(true);
  socket.snapshot({
    ...room,
    publicUpdatedAtMs: now + 1,
    settings: { ...room.settings, mode: "doubles" },
  });
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("拒否・送信失敗・切断でも下書きを失わず、情報変更時は読み直す", async () => {
  const room = waitingRoom();
  const { socket } = await setup(room);
  selectMode("doubles");
  press(dialog(), "適用");
  socket.receive({ type: "room.error", error: "forbidden" });
  await flush();
  expect(dialog().querySelector<HTMLInputElement>('input[value="doubles"]')!.checked).toBe(true);
  expect(dialog().textContent).toContain("ホストだけ");
  socket.failSend = true;
  press(dialog(), "適用");
  await flush();
  expect(dialog().textContent).toContain("変更できませんでした");
  socket.snapshot({ ...room, publicUpdatedAtMs: now + 1 });
  await flush();
  expect(dialog().textContent).toContain("設定を読み直してください");
  press(dialog(), "設定を読み直す");
  await flush();
  expect(dialog().querySelector<HTMLInputElement>('input[value="singles"]')!.checked).toBe(true);
  socket.close();
  await flush();
  expect(dialog().querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.disabled).toBe(false);
});

test("CPUの追加・削除・レベル変更も適用まで送らず、満席と取消を処理", async () => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 1);
  const { socket, session } = await setup(room);
  const group = (label: string) =>
    dialog().querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`)!;
  press(group("追加するCPUのレベル"), "Lv2");
  press(dialog(), "CPUを追加");
  press(group("CPU 1のレベル"), "Lv1");
  press(dialog(), "CPUを追加");
  press(dialog(), "CPUを追加");
  expect(
    [...dialog().querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "CPUを追加",
    )!.disabled,
  ).toBe(true);
  act(() => dialog().querySelector<HTMLButtonElement>('[aria-label="CPU 2を削除"]')!.click());
  expect(commands(socket)).toHaveLength(0);
  expect(session().room.players).toHaveLength(1);
  press(dialog(), "適用");
  expect(commands(socket)[0]).toMatchObject({
    cpus: [
      { playerId: null, level: 1 },
      { playerId: null, level: 2 },
    ],
  });
});

test("ログイン利用者の最初のCPUは適用時に確認し、編集に戻っても下書きを保持", async () => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 1);
  const { socket } = await setup(room, profile);
  press(dialog(), "CPUを追加");
  expect(dialog().textContent).not.toContain("CPUを追加しますか？");
  press(dialog(), "適用");
  await flush();
  expect(dialog().textContent).toContain("CPUを追加しますか？");
  expect(commands(socket)).toHaveLength(0);
  press(dialog(), "編集に戻る");
  await flush();
  expect(dialog().textContent).toContain("CPU 1");
  press(dialog(), "適用");
  await flush();
  press(dialog(), "CPUを追加して適用");
  await flush();
  expect(commands(socket)).toHaveLength(1);
});

test("将棋の三人攻撃禁止は共通ダイアログで一括適用", async () => {
  const room = waitingShogiRoom();
  saveRoomMembershipToken(room.id, token);
  function Settings() {
    const session = useFourShogiRoomSession({
      initialRoom: room,
      initialMembership: membership,
      initialServerNowMs: now,
      initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
    });
    const chat = useRoomChat({
      room: session.room,
      membership: session.membership,
      remoteError: session.chatError,
      sendChat: session.sendChat,
      clearRemoteError: session.clearChatError,
      notifications: session.chatNotifications,
      messages: session.chatMessages,
      connected: true,
    });
    return <FourShogiRoomView session={session} chat={chat} invited={false} />;
  }
  const view = render(wrap()(<Settings />));
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive({ type: "room.authenticated", membership });
  act(() => view.querySelector<HTMLElement>('[role="tab"][id$="-room"]')?.click());
  await flush();
  press(view, "ルーム設定");
  await flush();
  const selected = room.settings.threePlayerAttackProhibited ? "off" : "on";
  act(() => dialog().querySelector<HTMLInputElement>(`input[value="${selected}"]`)!.click());
  selectMode("doubles");
  expect(commands(socket)).toHaveLength(0);
  press(dialog(), "適用");
  expect(commands(socket)[0]).toMatchObject({
    mode: "doubles",
    threePlayerAttackProhibited: !room.settings.threePlayerAttackProhibited,
  });
});
