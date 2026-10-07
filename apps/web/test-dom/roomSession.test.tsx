import { afterEach, beforeEach, expect, test } from "bun:test";
import { applyAction, eliminateSide } from "@tetraboard/four-shogi";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { useFourShogiRoomSession } from "../src/features/room/useFourShogiRoomSession";
import {
  membership,
  now,
  playerIds,
  token,
  waitingRoom,
  playingRoom,
} from "../test/fixtures/rooms";
import {
  initialShogiState,
  playingShogiRoom,
  waitingShogiRoom,
} from "../test/fixtures/fourShogiFixtures";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import { act, clock, flush, renderHook, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";
import type { Room } from "@tetraboard/protocol";

let restoreSocket: () => void;
beforeEach(() => {
  restoreSocket = installSocket();
});
afterEach(() => restoreSocket());

function options<T extends Room>(room: T) {
  saveRoomMembershipToken(room.id, token);
  return {
    initialRoom: room,
    initialMembership: membership,
    initialServerNowMs: now,
    initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
  };
}
function connected(room: Room) {
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive({ type: "room.authenticated", membership });
  return socket;
}
test("開始・準備・設定は認証とhost権限が必要で、同期的な連打を一度だけ送る", () => {
  const room = waitingRoom();
  room.players.forEach((p) => (p.ready = true));
  const h = renderHook(useRoomSession, options(room), wrap());
  act(() => h.current.handleStartClick());
  expect(Socket.instances[0]!.sent).toHaveLength(0);
  const socket = connected(room);
  expect(socket.sent[0]).toEqual({ type: "room.auth", token });
  act(() => {
    h.current.handleStartClick();
    h.current.handleStartClick();
  });
  expect(socket.sent.filter((m) => m.type === "room.game.start")).toHaveLength(1);
  socket.snapshot(room);
  expect(h.current.pendingGameAction?.type).toBe("start");
  socket.snapshot(playingRoom());
  expect(h.current.pendingGameAction).toBeNull();
  socket.snapshot(room);
  act(() => {
    h.current.changeMode("doubles");
    h.current.changeMode("singles");
  });
  expect(socket.sent.filter((m) => m.type === "room.mode.set")).toEqual([
    { type: "room.mode.set", mode: "doubles" },
  ]);
  expect(h.current.canManageSettings).toBe(false);
  expect(h.current.pendingSettingsCommand).toEqual({ type: "room.mode.set", mode: "doubles" });
  socket.snapshot(room);
  expect(h.current.canManageSettings).toBe(true);
  expect(h.current.pendingSettingsCommand).toBeNull();
  act(() => {
    h.current.handleReadyClick();
    h.current.handleReadyClick();
  });
  expect(socket.sent.filter((m) => m.type === "room.ready.set")).toHaveLength(1);
  socket.snapshot(room);
  expect(h.current.pendingReady).toBe(false);
  socket.snapshot({
    ...room,
    players: room.players.map((p, i) =>
      i === 0 && p.kind === "human" ? { ...p, ready: false } : p,
    ),
  });
  expect(h.current.pendingReady).toBeNull();
  socket.receive({ type: "room.authenticated", membership: { ...membership, role: "player" } });
  act(() => h.current.addCpu(2));
  expect(socket.sent.filter((m) => m.type === "room.cpu.add")).toHaveLength(0);
});

test("将棋の合法手・局ID・revision、未確定盤、3000ms境界、同局面保持と拒否を検証", () => {
  const state = initialShogiState(),
    room = playingShogiRoom(state);
  const h = renderHook(useFourShogiRoomSession, options(room), wrap());
  const socket = connected(room),
    action = room.legalActions[0]!;
  act(() =>
    expect(
      h.current.handleShogiAction({
        type: "movePiece",
        from: { x: 0, y: 0 },
        to: { x: 8, y: 8 },
        promote: false,
      }),
    ).toBe(false),
  );
  act(() => {
    expect(h.current.handleShogiAction(action)).toBe(true);
    expect(h.current.handleShogiAction(action)).toBe(false);
  });
  expect(socket.sent.at(-1)).toEqual({
    type: "room.game.action",
    action,
    roundId: room.roundId,
    positionRevision: 0,
  });
  expect(h.current.displayGame.board).not.toEqual(room.game.board);
  socket.snapshot(room);
  expect(h.current.pendingMove).not.toBeNull();
  clock.advance(2999);
  expect(h.current.moveNotice).toBeNull();
  clock.advance(1);
  expect(h.current.moveNotice).toBe("着手を送信中…");
  socket.receive({ type: "room.error", error: "invalid_move" });
  expect(h.current.pendingMove).toBeNull();
  expect(h.current.moveNotice).toBeNull();
  expect(h.current.displayGame).toEqual(room.game);
  act(() => h.current.handleShogiAction(action));
  const moved = applyAction(state, "south", action);
  if (!moved.ok) throw new Error("fixture");
  socket.snapshot(playingShogiRoom(moved.state, 1));
  expect(h.current.pendingMove).toBeNull();
  expect(h.current.displayGame.board).toEqual(moved.state.board);
});

test("将棋の提案は二重送信せず反映・局ID変更で解除、送信例外・切断も盤を戻す", () => {
  const room = playingShogiRoom();
  const h = renderHook(useFourShogiRoomSession, options(room), wrap());
  const socket = connected(room);
  act(() => {
    h.current.handleDrawProposalClick();
    h.current.handleDrawProposalClick();
  });
  expect(socket.sent.filter((m) => m.type === "room.game.draw.set")).toHaveLength(1);
  socket.snapshot(room);
  expect(h.current.pendingGameAction?.type).toBe("draw");
  socket.snapshot({ ...room, game: { ...room.game, drawProposals: ["south"] } });
  expect(h.current.pendingGameAction).toBeNull();
  socket.snapshot(room);
  act(() => h.current.handleShogiAction(room.legalActions[0]!));
  socket.snapshot({ ...room, roundId: "00000000-0000-4000-8000-000000000021" });
  expect(h.current.pendingMove).toBeNull();
  socket.failSend = true;
  act(() => expect(h.current.handleShogiAction(room.legalActions[0]!)).toBe(false));
  expect(h.current.pendingMove).toBeNull();
  expect(h.current.socketError).toContain("送信できません");
  socket.failSend = false;
  act(() => h.current.handleShogiAction(room.legalActions[0]!));
  act(() => socket.close());
  expect(h.current.pendingMove).toBeNull();
  clock.advance(3000);
  expect(h.current.moveNotice).toBeNull();
});

test("再接続はGET・本人確認を経由し、解析対応を引継ぎ、閉鎖と世代変更では再試行を止める", async () => {
  const room = waitingShogiRoom();
  const h = renderHook(
    useFourShogiRoomSession,
    { ...options(room), initialFormationAnalysisSupported: true },
    wrap(),
  );
  const socket = connected(room);
  expect(socket.url).toContain("formationAnalysis=1");
  act(() => socket.close());
  clock.advance(999);
  expect(requests).toHaveLength(0);
  clock.advance(1);
  expect(requests[0]!.url).toContain("formationAnalysis=1");
  requests[0]!.respond({
    room,
    presence: { hostPlayerId: playerIds[0], connectedPlayerIds: playerIds },
    serverNowMs: now,
    formationAnalysis: null,
  });
  await flush();
  requests[1]!.respond(membership);
  await flush();
  expect(Socket.instances[1]!.url).toContain("formationAnalysis=1");
  connected(room).receive({ type: "room.error", error: "not_found" });
  expect(h.current.unavailable).toContain("閉鎖");
  clock.advance(60000);
  expect(requests).toHaveLength(2);
});

test("認証不一致・異なる世代・不正メッセージを受け入れず、観戦は操作を送らない", () => {
  const room = waitingRoom();
  const h = renderHook(useRoomSession, options(room), wrap());
  const socket = connected(room);
  socket.receive({
    type: "room.authenticated",
    membership: { playerId: playerIds[1], role: "player" },
  });
  expect(h.current.authenticated).toBe(false);
  act(() => h.current.changeMode("doubles"));
  expect(socket.sent.filter((m) => m.type === "room.mode.set")).toHaveLength(0);
  socket.snapshot({ ...room, instanceId: "00000000-0000-4000-8000-000000000011" });
  expect(h.current.unavailable).toContain("閉鎖");
  h.unmount();
  const viewer = renderHook(
    useFourShogiRoomSession,
    { ...options(playingShogiRoom()), initialMembership: null },
    wrap(),
  );
  const v = Socket.instances.at(-1)!;
  v.open();
  v.snapshot(playingShogiRoom());
  act(() => {
    viewer.current.handleResignClick();
    viewer.current.handleDrawProposalClick();
  });
  expect(v.sent).toHaveLength(0);
  v.receive({ unexpected: true });
  expect(v.readyState).toBe(3);
});

test("投了pendingは他人の脱落では維持し、本人の脱落で解除する", () => {
  const state = initialShogiState(),
    room = playingShogiRoom(state);
  const h = renderHook(useFourShogiRoomSession, options(room), wrap());
  const socket = connected(room);
  act(() => {
    h.current.handleResignClick();
    h.current.handleResignClick();
  });
  expect(socket.sent.filter((m) => m.type === "room.game.resign")).toHaveLength(1);
  const other = eliminateSide(state, "west", "left");
  if (!other.ok) throw new Error("fixture");
  socket.snapshot(playingShogiRoom(other.state, 1));
  expect(h.current.pendingGameAction?.type).toBe("resign");
  const self = eliminateSide(other.state, "south", "resigned");
  if (!self.ok) throw new Error("fixture");
  socket.snapshot(playingShogiRoom(self.state, 2));
  expect(h.current.pendingGameAction).toBeNull();
  expect(h.current.canPlay).toBe(false);
});

test("時計は受信server時刻と経過時間を使い、チャット履歴の再送は通知を重複しない", () => {
  const room = playingRoom();
  const h = renderHook(useRoomSession, options(room), wrap());
  const socket = connected(room);
  clock.advance(250);
  expect(h.current.serverNowMs).toBe(now + 250);
  const entry = {
    id: crypto.randomUUID(),
    kind: "player",
    senderId: playerIds[1],
    senderName: "参加者2",
    text: "こんにちは",
    sentAtMs: now,
  };
  socket.receive({ type: "room.chat.snapshot", messages: [] });
  socket.receive({ type: "room.chat.snapshot", messages: [entry] });
  socket.receive({ type: "room.chat.snapshot", messages: [entry] });
  expect(h.current.chatMessages).toHaveLength(1);
  expect(h.current.chatNotifications).toHaveLength(1);
  act(() => expect(h.current.sendChat("返信")).toBe(true));
  expect(socket.sent.at(-1)).toEqual({ type: "room.chat.send", text: "返信" });
});
