import { afterEach, beforeEach, expect, test } from "bun:test";
import { useLocation } from "react-router";
import { fourReversiRoomSchema, shogiRoomSchema, type FourReversiRoom } from "@tetraboard/protocol";
import { RoomView } from "../src/features/room/RoomView";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { useRoomChat } from "../src/features/room/useRoomChat";
import { saveRoomMembershipToken, readRoomMembershipToken } from "../src/shared/roomMembership";
import { waitingRoom, membership, now, playerIds, token } from "../test/fixtures/rooms";
import { replayMatch } from "../test/fixtures/matchReplayFixtures";
import { profile } from "../test/fixtures/account";
import { clock, flush, press, render, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";
import { ShogiRoomView } from "../src/features/room/ShogiRoomView";
import { useShogiRoomSession } from "../src/features/room/useShogiRoomSession";
import { standardSavedRound, standardWaitingRoom } from "../test/fixtures/standardShogiFixtures";
import {
  readMatchmakingQueue,
  readMatchmakingRoom,
  saveMatchmakingQueue,
  saveMatchmakingRoom,
} from "../src/features/matchmaking/matchmakingStorage";
import { matchmakingScope } from "../src/features/matchmaking/paths";
import { queueDocumentController } from "../src/shared/QueueDocumentController";
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
        <output data-path>{location.pathname + location.search}</output>
        <output data-rejoin>{String(location.state?.matchmakingRejoin === true)}</output>
        <RoomView session={session} chat={chat} invited={false} />
      </>
    );
  }
  const view = render(
    wrap({ ...profile, profileId: crypto.randomUUID() }, "/rooms/12345")(<View />),
  );
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
    const { view, socket } = await setup(room);
    const identity = crypto.randomUUID();
    const game = "four-reversi";
    const scope = matchmakingScope(identity, game);
    const previous = {
      operationId: crypto.randomUUID(),
      controllerId: queueDocumentController.getIdentity(),
      version: 1,
    };
    saveMatchmakingQueue(identity, previous, game);
    saveMatchmakingRoom({
      ...previous,
      identity,
      game,
      roomId: room.id,
      instanceId: room.instanceId,
    });
    queueDocumentController.remember(scope, previous.operationId, 1);
    press(view, "結果");
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("棋譜を見る");
    press(dialog, action);
    const lastLeave = () => requests.filter((r) => r.url.endsWith("/leave")).at(-1)!;
    const request = lastLeave();
    expect(request).toBeDefined();
    expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
    expect(readRoomMembershipToken(room.id)).toBe(token);
    if (action === "もう一度マッチング") {
      request.respond({ error: "internal_error" }, 500);
      await flush();
      expect(readRoomMembershipToken(room.id)).toBe(token);
      expect(readMatchmakingRoom(room.id, room.instanceId)?.operationId).toBe(previous.operationId);
      expect(readMatchmakingQueue(identity, game)).toEqual(previous);
      expect(queueDocumentController.version(scope, previous.operationId)).toBe(1);
      press(dialog, action);
      socket.receive({ type: "room.error", error: "not_found" });
      await flush();
      expect(view.querySelector("[data-path]")?.textContent).toBe("/rooms/12345");
    }
    const later = { ...previous, operationId: crypto.randomUUID() };
    if (action === "ロビーへ") {
      saveMatchmakingQueue(identity, later, game);
      queueDocumentController.remember(scope, later.operationId, 1);
    }
    lastLeave().respond(null, 204);
    await flush();
    expect(readRoomMembershipToken(room.id)).toBeNull();
    expect(readMatchmakingRoom(room.id, room.instanceId)).toBeNull();
    expect(readMatchmakingQueue(identity, game)).toEqual(action === "ロビーへ" ? later : null);
    expect(queueDocumentController.version(scope, previous.operationId)).toBeNull();
    if (action === "ロビーへ") {
      expect(queueDocumentController.version(scope, later.operationId)).toBe(1);
      queueDocumentController.forget(scope);
    }
    expect(view.querySelector("[data-path]")?.textContent).toBe(
      action === "もう一度マッチング" ? "/games/four-reversi?matchmaking=1" : "/games/four-reversi",
    );
    expect(view.querySelector("[data-rejoin]")?.textContent).toBe(
      String(action === "もう一度マッチング"),
    );
  });

test.each([false, true])(
  "四人リバーシの終局で4席のレートを表示する（本人の認定完了: %s）",
  async (placementCompleted) => {
    const match = replayMatch();
    const base = waiting();
    const room = fourReversiRoomSchema.parse({
      ...base,
      matchmaking: { ...base.matchmaking, rated: true },
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
    const rejoin = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("もう一度マッチング"),
    )!;
    expect(rejoin.disabled).toBe(true);
    const path = `/api/matchmaking/four-reversi/results/${room.matchmaking!.id}?includeOpponent=1`;
    requests
      .find((r) => r.url === path)!
      .respond({
        status: "rated",
        rating: 1542,
        previousRating: 1555,
        placementCompleted,
        humanPlayed: !placementCompleted,
        players: {
          [playerIds[1]!]: { status: "rated", rating: 1513, previousRating: 1500 },
          [playerIds[2]!]: { status: "placement" },
          [playerIds[3]!]: { status: "cpu", rating: 1500 },
        },
      });
    await flush();
    for (const [index, label] of [
      placementCompleted ? "1542" : "1542 (-13)",
      "1513 (+13)",
      "認定中",
      "1500",
    ].entries()) {
      const participant = dialog.querySelector(`[data-player-id="${playerIds[index]}"]`)!;
      expect(participant.lastElementChild?.lastElementChild?.textContent).toBe(label);
    }
    if (placementCompleted) {
      expect(dialog.textContent).toContain("認定完了");
      expect(dialog.textContent).not.toContain("対人戦未経験");
    }
    expect(rejoin.disabled).toBe(false);
  },
);

test.each([
  {
    opponent: "cpu",
    rating: {
      status: "rated",
      rating: 1524,
      previousRating: 1500,
      placementCompleted: true,
      humanPlayed: false,
      opponent: { status: "cpu", rating: 1500 },
    },
    labels: ["1524 (+24)", "1500"],
  },
  {
    opponent: "human",
    rating: {
      status: "rated",
      rating: 1542,
      previousRating: 1555,
      placementCompleted: false,
      humanPlayed: true,
      opponent: { status: "rated", rating: 1513, previousRating: 1500 },
    },
    labels: ["1542 (-13)", "1513 (+13)"],
  },
  {
    opponent: "human",
    rating: { status: "placement", games: 3, opponent: { status: "placement" } },
    labels: ["認定戦 3 / 5局", "認定中"],
  },
])(
  "将棋はレート保存完了後に各行に結果を表示し、将棋の待機列に戻る (%j)",
  async ({ opponent, rating, labels }) => {
    const saved = standardSavedRound().match;
    const room = shogiRoomSchema.parse({
      ...standardWaitingRoom(),
      matchmaking: { id: saved.id, opponent, preparedAtMs: now },
      lastRound: {
        roundId: saved.id,
        game: saved.game,
        eventCount: saved.replay.eventCount,
        players: saved.participants.map(({ id, name, side }) => ({ id, name, side })),
      },
    });
    const initialMembership = { ...membership, accountLinked: true };
    saveRoomMembershipToken(room.id, token);
    function View() {
      const location = useLocation();
      const session = useShogiRoomSession({
        initialRoom: room,
        initialMembership,
        initialServerNowMs: now,
        initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds.slice(0, 2) },
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
          <output data-path>{location.pathname + location.search}</output>
          <ShogiRoomView session={session} chat={chat} invited={false} />
        </>
      );
    }
    const view = render(
      wrap({ ...profile, profileId: crypto.randomUUID() }, "/rooms/12345")(<View />),
    );
    const socket = Socket.instances.at(-1)!;
    socket.open();
    socket.snapshot(room);
    socket.receive({ type: "room.authenticated", membership: initialMembership });
    await flush();
    press(view, "結果");
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const ratingRequest = () =>
      requests.filter((r) => r.url.endsWith(`/results/${saved.id}?includeOpponent=1`)).at(-1)!;
    const rejoin = () =>
      [...dialog.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("もう一度マッチング"),
      )!;
    ratingRequest().respond({ status: "pending" });
    await flush();
    expect(rejoin().disabled).toBe(true);
    expect(dialog.textContent).toContain("レート結果を保存しています");
    clock.advance(1000);
    await flush();
    ratingRequest().respond(rating);
    await flush();
    const spans = [...dialog.querySelectorAll("span")];
    for (const [index, player] of saved.participants.entries()) {
      const name = spans.find((span) => span.textContent === player.name);
      expect(name?.nextElementSibling?.textContent).toBe(labels[index]);
    }
    expect(dialog.textContent).not.toContain("レート 1524");
    if (opponent === "cpu") {
      expect(dialog.textContent).toContain("認定完了");
      expect(dialog.textContent).toContain("対人戦未経験");
    }
    expect(rejoin().disabled).toBe(false);
    press(dialog, "もう一度マッチング");
    requests.find((r) => r.url.endsWith("/leave"))!.respond(null, 204);
    await flush();
    expect(view.querySelector("[data-path]")?.textContent).toBe("/games/shogi?matchmaking=1");
  },
);
