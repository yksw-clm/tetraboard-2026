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
import { act, clock, flush, press, render, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";

let restore: () => void;
beforeEach(() => {
  restore = installSocket();
});
afterEach(() => restore());
async function setup(room: FourShogiRoom, spectator = false) {
  if (!spectator) saveRoomMembershipToken(room.id, token);
  const initialMembership = spectator ? null : { ...membership, accountLinked: true };
  function View() {
    const location = useLocation();
    const session = useFourShogiRoomSession({
      initialRoom: room,
      initialMembership,
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
        <output aria-label="サーバー時刻">{session.serverNowMs}</output>
        <output aria-label="接続状態">{session.connection}</output>
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

test("大会の開始予告は同期したサーバー時刻で5秒を数え、実開始snapshotまで手を進めない", async () => {
  const room = { ...waitingShogiRoom(), tournamentId: 1, tournamentStartsAtMs: now + 5000 };
  const { view, socket } = await setup(room);
  const overlay = () => view.querySelector('[aria-label="大会対局の開始カウントダウン"]');
  expect(overlay()?.querySelector("strong")?.textContent).toBe("5");
  expect(overlay()?.className).toContain("absolute");
  expect(overlay()?.className).toContain("inset-0");
  expect(view.querySelector<HTMLElement>("main > div.contents")?.inert).toBe(true);
  clock.advance(1000);
  await flush();
  expect(overlay()?.querySelector("strong")?.textContent).toBe("4");
  socket.snapshot(room, now + 3500);
  await flush();
  expect(overlay()?.querySelector("strong")?.textContent).toBe("2");
  expect(view.querySelector('[aria-label="サーバー時刻"]')?.textContent).toBe(String(now + 3500));
  clock.advance(1500);
  await flush();
  expect(overlay()?.textContent).toContain("対局を開始しています");
  expect(socket.sent.some((message) => message.type === "room.start")).toBe(false);
  socket.snapshot({ ...playingShogiRoom(), tournamentId: 1 }, now + 5000);
  await flush();
  expect(Boolean(overlay())).toBe(false);
  expect(view.querySelector<HTMLElement>("main > div.contents")?.inert).toBe(false);
});

test("大会開始のカウントダウン中は既存dialogを隠し、予告が解除されたら暗い画面も解除する", async () => {
  const room = { ...waitingShogiRoom(), tournamentId: 1 };
  const { view, socket } = await setup(room);
  press(view, "不具合・ご意見");
  await flush();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  socket.snapshot({ ...room, tournamentStartsAtMs: now + 5000 });
  await flush();
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
  expect(view.querySelector('[aria-label="大会対局の開始カウントダウン"]')).not.toBeNull();
  socket.snapshot(room, now + 1000);
  await flush();
  expect(view.querySelector('[aria-label="大会対局の開始カウントダウン"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

test.each(["unavailable", "left", "transferred"] as const)(
  "大会ルームの本人への%s通知は大会ページへ戻す",
  async (reason) => {
    const room = { ...waitingShogiRoom(), tournamentId: 1 };
    const { view, socket } = await setup(room);
    socket.receive({
      type: "room.tournament.return",
      tournamentId: 1,
      matchId: "00000000-0000-4000-8000-000000000031",
      instanceId: room.instanceId,
      reason,
    });
    await flush();
    expect(view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe("/tournaments/1");
  },
);

test("別instanceの復帰通知と観戦者への復帰通知は現在のページを移動させない", async () => {
  const room = { ...waitingShogiRoom(), tournamentId: 1 };
  const { view, socket } = await setup(room);
  socket.receive({
    type: "room.tournament.return",
    tournamentId: 1,
    matchId: "00000000-0000-4000-8000-000000000031",
    instanceId: "00000000-0000-4000-8000-000000000032",
    reason: "unavailable",
  });
  await flush();
  expect(view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe("/rooms/12345");
  const spectator = await setup(room, true);
  spectator.socket.receive({
    type: "room.tournament.return",
    tournamentId: 1,
    matchId: "00000000-0000-4000-8000-000000000031",
    instanceId: room.instanceId,
    reason: "transferred",
  });
  await flush();
  expect(spectator.view.querySelector('[aria-label="現在のパス"]')?.textContent).toBe(
    "/rooms/12345",
  );
});

test("サーバー時刻が短く古くても開始予告は最大5を表示し、元の開始期限で0になる", async () => {
  const room = { ...waitingShogiRoom(), tournamentId: 1, tournamentStartsAtMs: now + 5250 };
  const { view } = await setup(room);
  const overlay = () => view.querySelector('[aria-label="大会対局の開始カウントダウン"]');
  expect(overlay()?.querySelector("strong")?.textContent).toBe("5");
  clock.advance(1250);
  await flush();
  expect(overlay()?.querySelector("strong")?.textContent).toBe("4");
  clock.advance(4000);
  await flush();
  expect(overlay()?.querySelector("strong")).toBeNull();
  expect(overlay()?.textContent).toContain("対局を開始しています…");
  expect(view.textContent).not.toContain("大会対局中");
});
