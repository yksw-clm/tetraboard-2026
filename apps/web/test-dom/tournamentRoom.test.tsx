import { afterEach, beforeEach, expect, test } from "bun:test";
import { useLocation } from "react-router";
import type { FourShogiRoom } from "@tetraboard/protocol";
import { FourShogiRoomView } from "../src/features/room/FourShogiRoomView";
import { useFourShogiRoomSession } from "../src/features/room/useFourShogiRoomSession";
import { useRoomChat } from "../src/features/room/useRoomChat";
import { saveRoomMembershipToken, readRoomMembershipToken } from "../src/shared/roomMembership";
import {
  finishedShogiRound,
  playingShogiRoom,
  waitingShogiRoom,
} from "../test/fixtures/fourShogiFixtures";
import { membership, now, playerIds, token } from "../test/fixtures/rooms";
import { profile } from "../test/fixtures/account";
import { act, flush, press, render, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";

let restore: () => void;
beforeEach(() => {
  restore = installSocket();
});
afterEach(() => restore());
async function setup(room: FourShogiRoom, spectator = false) {
  if (!spectator) saveRoomMembershipToken(room.id, token);
  function View() {
    const location = useLocation();
    const session = useFourShogiRoomSession({
      initialRoom: room,
      initialMembership: spectator ? null : { ...membership, accountLinked: true },
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
    return (
      <>
        <output aria-label="現在のパス">{location.pathname}</output>
        <FourShogiRoomView session={session} chat={chat} invited={false} />
      </>
    );
  }
  const view = render(wrap(profile, "/rooms/12345")(<View />));
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  if (!spectator)
    socket.receive({
      type: "room.authenticated",
      membership: { ...membership, accountLinked: true },
    });
  await flush();
  return { view, socket };
}
test("大会ルームでは通常の準備・開始・設定・引分を表示せず、観戦者を大会へ案内する", async () => {
  const room = { ...waitingShogiRoom(), tournamentId: 1 };
  const { view } = await setup(room);
  expect(view.textContent).not.toContain("準備完了");
  expect(view.textContent).not.toContain("準備取消");
  expect(view.textContent).not.toContain("対局開始");
  expect(view.textContent).not.toContain("ルーム設定");
  const playing = { ...playingShogiRoom(), tournamentId: 1 };
  Socket.instances.at(-1)!.snapshot(playing);
  expect(view.textContent).not.toContain("引分提案");
  const spectator = await setup(room, true);
  press(spectator.view, "大会へ");
  await flush();
  expect(spectator.view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe(
    "/tournaments/1",
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
test("次の対局は旧席の退室成功後だけ大会ページへ進み、失敗時は資格と画面を保持する", async () => {
  const room = { ...finishedShogiRound().room, tournamentId: 2 };
  const { view } = await setup(room);
  press(view, "次の対局");
  const first = requests.find((request) => request.url.endsWith(`/rooms/${room.id}/leave`))!;
  expect(first).toBeDefined();
  expect(view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe("/rooms/12345");
  expect(readRoomMembershipToken(room.id)).toBe(token);
  act(() => first.respond({ error: "internal_error" }, 503));
  await flush();
  expect(view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe("/rooms/12345");
  expect(readRoomMembershipToken(room.id)).toBe(token);
  press(view, "次の対局");
  const second = requests
    .filter((request) => request.url.endsWith(`/rooms/${room.id}/leave`))
    .at(-1)!;
  act(() => second.respond(null, 204));
  await flush();
  expect(view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe("/tournaments/2");
  expect(readRoomMembershipToken(room.id)).toBeNull();
});
