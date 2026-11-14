import {
  isFourReversiRoom,
  isFourShogiRoom,
  type FourReversiRoom,
  type FourShogiRoom,
  type Room,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";

export type Snapshot = Extract<RoomSocketMessage, { type: "room.snapshot" }>;
export type SupportedRoom = FourReversiRoom | FourShogiRoom;
export type Action = Extract<RoomSocketClientMessage, { type: "room.game.action" }>["action"];
export type Turn = {
  key: string;
  room: Extract<SupportedRoom, { status: "playing" }>;
  actions: Action[];
  serverNowMs: number;
  receivedAt: number;
};
export function supported(room: Room): room is SupportedRoom {
  return (isFourReversiRoom(room) || isFourShogiRoom(room)) && room.settings.mode === "singles";
}
export function actionKey(action: Action): string {
  if (action.type === "movePiece")
    return `move:${action.from.x},${action.from.y}:${action.to.x},${action.to.y}:${action.promote}`;
  if (action.type === "dropPiece") return `drop:${action.pieceKind}:${action.to.x},${action.to.y}`;
  return `${action.type}:${action.position.x},${action.position.y}`;
}
export function turnFor(snapshot: Snapshot, playerId: string, receivedAt: number): Turn | null {
  const room = snapshot.room;
  if (!supported(room) || room.status !== "playing") return null;
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return null;
  if (isFourShogiRoom(room) && room.status === "playing") {
    if (
      !("side" in player) ||
      player.side !== room.game.turn ||
      room.eliminations.some((e) => e.side === player.side)
    )
      return null;
    return {
      key: JSON.stringify([room.instanceId, room.roundId, room.positionRevision, room.game.turn]),
      room,
      actions: room.legalActions,
      serverNowMs: snapshot.serverNowMs,
      receivedAt,
    };
  }
  if (isFourReversiRoom(room) && room.status === "playing") {
    if (
      !("color" in player) ||
      player.color !== room.game.turn ||
      room.game.eliminatedColors.includes(player.color)
    )
      return null;
    return {
      key: JSON.stringify([
        room.instanceId,
        room.clock.turnStartedAt,
        room.game.moveNumber,
        room.game.turn,
      ]),
      room,
      actions: getLegalMoves(room.game).map((position) => ({ type: "placeStone", position })),
      serverNowMs: snapshot.serverNowMs,
      receivedAt,
    };
  }
  return null;
}
export function sendAt(turn: Turn, random = Math.random): number {
  return Math.min(turn.receivedAt + 5000 + Math.floor(random() * 13001), deadline(turn));
}
export function deadline(turn: Turn): number {
  return turn.receivedAt + Math.max(0, turn.room.clock.turnExpiresAt - turn.serverNowMs - 1000);
}
export function actionMessage(turn: Turn, action: Action): RoomSocketClientMessage {
  return isFourShogiRoom(turn.room)
    ? {
        type: "room.game.action",
        action,
        roundId: turn.room.roundId,
        positionRevision: turn.room.positionRevision,
      }
    : { type: "room.game.action", action };
}
