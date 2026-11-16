import {
  roomSocketContract,
  type Room,
  type RoomPresence,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import {
  roomFormationAnalysis,
  formationAnalysisTag,
} from "../../rooms/fourShogiFormationAnalysis";
import { eliminatedHandsTag } from "../../rooms/fourShogiProgress";
import { broadcastChat } from "./chat";
import { hasOpenConnection, sendCurrentMembership } from "./socket/membership";
import type { RoomSocketError } from "./runtime";
import type { RoomRuntime } from "./runtime";

export function presence(runtime: RoomRuntime, room: Room): RoomPresence {
  const host = room.players.find((player) => {
    const hash = runtime.playerTokenHash(player.id);
    return hash !== null && runtime.readMembership(hash)?.role === "host";
  });
  return {
    hostPlayerId: host?.id ?? null,
    connectedPlayerIds: room.players
      .filter((player) => {
        if (player.kind === "cpu") return true;
        const hash = runtime.playerTokenHash(player.id);
        return (
          hash !== null && runtime.readMembership(hash) !== null && hasOpenConnection(runtime, hash)
        );
      })
      .map((player) => player.id),
  };
}

export function broadcastRoom(runtime: RoomRuntime, room: Room): void {
  const snapshots = new Map<string, string>();
  for (const socket of runtime.ctx.getWebSockets()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    try {
      const tags = runtime.ctx.getTags(socket);
      const formation = tags.includes(formationAnalysisTag);
      const hands = tags.includes(eliminatedHandsTag);
      const key = `${formation}:${hands}`;
      let message = snapshots.get(key);
      if (message === undefined) {
        message = JSON.stringify(roomSnapshot(runtime, room, formation, hands));
        snapshots.set(key, message);
      }
      socket.send(message);
    } catch {
      // 切断中の接続への送信失敗は、保存済みのルーム状態に影響させません。
    }
  }
  if (runtime.chat.dirty) broadcastChat(runtime);
  if (room.status === "waiting" && room.lastRound !== null) {
    const host = room.players.find(
      (player) =>
        player.kind === "human" &&
        runtime.readMembership(runtime.playerTokenHash(player.id) ?? "")?.role === "host",
    );
    if (host !== undefined) {
      const hash = runtime.playerTokenHash(host.id);
      if (hash !== null) sendCurrentMembership(runtime, hash);
    }
  }
}

export function roomSnapshot(
  runtime: RoomRuntime,
  room: Room,
  formationAnalysis = false,
  eliminatedHands = false,
): RoomSocketMessage {
  return roomSocketContract.message.parse({
    type: "room.snapshot",
    room,
    presence: presence(runtime, room),
    serverNowMs: Date.now(),
    ...roomFormationAnalysis(room, formationAnalysis),
    ...runtime.gameAdapter(room).displayHands(room, eliminatedHands),
  });
}

export function sendRoomSnapshot(runtime: RoomRuntime, socket: WebSocket, room: Room): void {
  socket.send(
    JSON.stringify(
      roomSnapshot(
        runtime,
        room,
        runtime.ctx.getTags(socket).includes(formationAnalysisTag),
        runtime.ctx.getTags(socket).includes(eliminatedHandsTag),
      ),
    ),
  );
}

export function sendSocketError(
  runtime: RoomRuntime,
  socket: WebSocket,
  error: RoomSocketError,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(roomSocketContract.message.parse({ type: "room.error", error })));
  }
}

export function rejectAction(
  runtime: RoomRuntime,
  socket: WebSocket,
  error: RoomSocketError,
): void {
  sendSocketError(runtime, socket, error);
  const room = runtime.readRoom();
  if (room !== null && socket.readyState === WebSocket.OPEN) {
    sendRoomSnapshot(runtime, socket, room);
  }
}
