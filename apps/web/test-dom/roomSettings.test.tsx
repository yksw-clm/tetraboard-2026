import { afterEach, beforeEach, expect, test } from "bun:test";
import { useEffect, useRef } from "react";
import { RoomInfo } from "../src/features/room/RoomInfo";
import { FourShogiRoomView } from "../src/features/room/FourShogiRoomView";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { useFourShogiRoomSession } from "../src/features/room/useFourShogiRoomSession";
import { useRoomChat } from "../src/features/room/useRoomChat";
import { useCpuAddition } from "../src/features/room/useCpuAddition";
import { useAccount } from "../src/features/account/useAccount";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import { waitingRoom, membership, token, now, playerIds } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { act, clock, flush, press, render, wrap } from "./harness";
import { installSocket, Socket } from "./socket";

let restoreSocket: () => void;
beforeEach(() => {
  restoreSocket = installSocket();
});
afterEach(() => restoreSocket());

test("開いた設定は送信中の選択を保ち、確定・拒否・送信失敗・切断で確定値へ戻る", async () => {
  const room = waitingRoom();
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
    const ref = useRef<HTMLButtonElement>(null);
    const account = useAccount();
    const addition = useCpuAddition({
      room: currentSession.room,
      membership: currentSession.membership,
      hostPlayerId: currentSession.presence.hostPlayerId,
      canManageSettings: currentSession.canManageSettings,
      account,
      addCpu: currentSession.addCpu,
    });
    return (
      <RoomInfo
        session={currentSession}
        onLeave={() => {}}
        onCopyInvite={() => {}}
        onAddCpu={addition.request}
        cpuAddButtonRef={ref}
        canAddCpu={addition.canAdd}
        onFeedback={() => {}}
        feedbackButtonRef={ref}
      />
    );
  }
  const view = render(wrap()(<Settings />));
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive({ type: "room.authenticated", membership });
  press(view, "ルーム設定");
  await flush();
  clock.advance(300);
  const trigger = () =>
    [...view.querySelectorAll("button")].find((b) => b.textContent === "ルーム設定")!;
  const checked = (value: string) =>
    view.querySelector<HTMLInputElement>(`input[type=radio][value=${value}]`)!.checked;
  act(() => {
    session.changeMode("doubles");
    session.changeMode("singles");
  });
  expect(checked("doubles")).toBe(true);
  expect(session!.room.settings.mode).toBe("singles");
  expect(view.textContent).toContain("設定を更新中…");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(socket.sent.filter((m) => m.type === "room.mode.set")).toHaveLength(1);
  socket.snapshot({ ...room, settings: { ...room.settings, mode: "doubles" } });
  expect(checked("doubles")).toBe(true);
  expect(view.textContent).not.toContain("設定を更新中…");
  act(() => session.changeTimeControl({ mainTimeMs: 600_000, byoyomiMs: 10_000 }));
  expect(view.querySelectorAll('[data-slot="select-value"]')[0]!.textContent).toBe("10分");
  expect(view.querySelectorAll('[data-slot="select-value"]')[1]!.textContent).toBe("10秒");
  socket.receive({ type: "room.error", error: "invalid_request" });
  expect(view.querySelectorAll('[data-slot="select-value"]')[0]!.textContent).toBe("5分");
  socket.failSend = true;
  act(() => session.changeMode("singles"));
  expect(checked("doubles")).toBe(true);
  expect(view.textContent).not.toContain("設定を更新中…");
  socket.failSend = false;
  act(() => session.changeMode("singles"));
  expect(checked("singles")).toBe(true);
  act(() => socket.close());
  expect(checked("doubles")).toBe(true);
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
});

test("CPUの追加レベルを送信し、既存CPUの送信中レベルを表示し、満席では追加しない", async () => {
  const room = waitingRoom();
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
    const ref = useRef<HTMLButtonElement>(null);
    const account = useAccount();
    const addition = useCpuAddition({
      room: currentSession.room,
      membership: currentSession.membership,
      hostPlayerId: currentSession.presence.hostPlayerId,
      canManageSettings: currentSession.canManageSettings,
      account,
      addCpu: currentSession.addCpu,
    });
    return (
      <RoomInfo
        session={currentSession}
        onLeave={() => {}}
        onCopyInvite={() => {}}
        onAddCpu={addition.request}
        cpuAddButtonRef={ref}
        canAddCpu={addition.canAdd}
        onFeedback={() => {}}
        feedbackButtonRef={ref}
      />
    );
  }
  const view = render(wrap()(<Settings />));
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot({ ...room, players: room.players.slice(0, 1) });
  socket.receive({ type: "room.authenticated", membership });
  press(view, "ルーム設定");
  await flush();
  clock.advance(300);
  const group = (label: string) =>
    view.querySelector<HTMLElement>(`[role=group][aria-label="${label}"]`)!;
  press(group("追加するCPUのレベル"), "Lv2");
  press(view, "CPUを追加");
  expect(socket.sent.filter((m) => m.type === "room.cpu.add")).toEqual([
    { type: "room.cpu.add", level: 2 },
  ]);
  const cpu = {
    id: playerIds[1]!,
    name: "CPU Lv2",
    kind: "cpu" as const,
    level: 2 as const,
    ready: true as const,
    reconnectDeadline: null,
    color: null,
  };
  socket.snapshot({ ...room, players: [room.players[0]!, cpu] });
  press(group("CPU 1のレベル"), "Lv1");
  expect(group("CPU 1のレベル").querySelector("[aria-pressed=true]")!.textContent).toContain("Lv1");
  expect(session!.room.players.find((p) => p.id === cpu.id)).toMatchObject({ level: 2 });
  socket.snapshot({ ...room, players: [room.players[0]!, cpu] });
  expect(group("CPU 1のレベル").querySelector("[aria-pressed=true]")!.textContent).toBe("Lv2");
  socket.snapshot({
    ...room,
    players: [room.players[0]!, cpu, { ...cpu, id: playerIds[2]! }, { ...cpu, id: playerIds[3]! }],
  });
  press(view, "CPUを追加");
  expect(socket.sent.filter((m) => m.type === "room.cpu.add")).toHaveLength(1);
});

test("将棋の三人攻撃禁止も送信中の値を表示し、拒否で確定値へ戻す", async () => {
  const room = waitingShogiRoom();
  saveRoomMembershipToken(room.id, token);
  let session: ReturnType<typeof useFourShogiRoomSession>;
  function Settings() {
    const currentSession = useFourShogiRoomSession({
      initialRoom: room,
      initialMembership: membership,
      initialServerNowMs: now,
      initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
    });
    useEffect(() => {
      session = currentSession;
    }, [currentSession]);
    const chat = useRoomChat({
      room: currentSession.room,
      membership: currentSession.membership,
      remoteError: currentSession.chatError,
      sendChat: currentSession.sendChat,
      clearRemoteError: currentSession.clearChatError,
      notifications: currentSession.chatNotifications,
      messages: currentSession.chatMessages,
      connected: true,
    });
    return <FourShogiRoomView session={currentSession} chat={chat} invited={false} />;
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
  clock.advance(300);
  act(() => session.changeThreePlayerAttack(!room.settings.threePlayerAttackProhibited));
  const chosen = room.settings.threePlayerAttackProhibited ? "off" : "on";
  expect(view.querySelector<HTMLInputElement>(`input[type=radio][value=${chosen}]`)!.checked).toBe(
    true,
  );
  socket.receive({ type: "room.error", error: "invalid_request" });
  expect(view.querySelector<HTMLInputElement>(`input[type=radio][value=${chosen}]`)!.checked).toBe(
    false,
  );
});
