import { afterEach, beforeEach, expect, test } from "bun:test";
import { useLocation } from "react-router";
import { fourReversiRoomSchema, type FourReversiRoom } from "@tetraboard/protocol";
import { RoomView } from "../src/features/room/RoomView";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { useRoomChat } from "../src/features/room/useRoomChat";
import { saveRoomMembershipToken, readRoomMembershipToken } from "../src/shared/roomMembership";
import { waitingRoom, membership, now, playerIds, token } from "../test/fixtures/rooms";
import { replayMatch } from "../test/fixtures/matchReplayFixtures";
import { profile } from "../test/fixtures/account";
import { clock, flush, press, render, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";
let restore: () => void;
beforeEach(() => {
  restore = installSocket();
});
afterEach(() => restore());
function waiting() {
  return fourReversiRoomSchema.parse({
    ...waitingRoom(),
    settings: {
      game: "four-reversi",
      mode: "singles",
      timeControl: { mainTimeMs: 180000, byoyomiMs: 0 },
    },
    matchmaking: { id: crypto.randomUUID(), preparedAtMs: now },
  });
}
async function setup(room: FourReversiRoom) {
  saveRoomMembershipToken(room.id, token);
  const initialMembership = { ...membership, accountLinked: true };
  function View() {
    const location = useLocation();
    const session = useRoomSession({
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
        <output data-path>{location.pathname}</output>
        <output data-rejoin>{String(location.state?.matchmakingRejoin === true)}</output>
        <RoomView session={session} chat={chat} invited={false} />
      </>
    );
  }
  const view = render(wrap(profile, "/rooms/12345")(<View />));
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive({
    type: "room.authenticated",
    membership: { ...membership, accountLinked: true },
  });
  await flush();
  return { view, socket };
}
test("マッチング専用ルームは手動準備・開始・設定を出さず、接続後の開始予告を表示する", async () => {
  const room = waiting();
  const { view, socket } = await setup(room);
  expect(view.textContent).not.toContain("対局開始");
  expect(view.textContent).not.toContain("ルーム設定");
  expect(view.textContent).not.toContain("準備取消");
  socket.snapshot({ ...room, matchmaking: { ...room.matchmaking!, startsAtMs: now + 5000 } });
  await flush();
  const overlay = () => view.querySelector('[aria-label="対局の開始カウントダウン"]');
  expect(overlay()?.querySelector("strong")?.textContent).toBe("5");
  clock.advance(1000);
  await flush();
  expect(overlay()?.querySelector("strong")?.textContent).toBe("4");
  expect(socket.sent.some((m) => m.type === "room.start")).toBe(false);
  socket.snapshot(room, now + 1000);
  await flush();
  expect(overlay()).toBeNull();
});
for (const action of ["もう一度マッチング", "ロビーへ"])
  test(`終局後の「${action}」は旧席の解放成功を待ち、次の待機は明示した場合だけ開始する`, async () => {
    const match = replayMatch();
    const room = fourReversiRoomSchema.parse({
      ...waiting(),
      lastRound: {
        game: match.game,
        replay: match.replay,
        players: match.participants.map((p, i) => ({
          id: playerIds[i],
          name: p.name,
          color: p.color,
        })),
      },
    });
    const { view } = await setup(room);
    press(view, "結果");
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("棋譜を見る");
    press(dialog, action);
    const request = requests.find((r) => r.url.endsWith("/leave"))!;
    expect(request).toBeDefined();
    expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
    expect(readRoomMembershipToken(room.id)).toBe(token);
    request.respond(null, 204);
    await flush();
    expect(readRoomMembershipToken(room.id)).toBeNull();
    expect(view.querySelector("[data-path]")?.textContent).toBe(
      action === "もう一度マッチング" ? "/games/four-reversi/matchmaking" : "/games/four-reversi",
    );
    expect(view.querySelector("[data-rejoin]")?.textContent).toBe(
      String(action === "もう一度マッチング"),
    );
  });
