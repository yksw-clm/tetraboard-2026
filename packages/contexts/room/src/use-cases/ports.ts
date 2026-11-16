import type { GameId, Room, RoomMembership, SystemChatMessage } from "@tetraboard/protocol";
import type { RoomEffect, RoomOutcome } from "./effects";
import type { RoomGamePort } from "./gamePort";
import type { FinishedFor } from "./gameProgress";

export type RoomAdmission = {
  instanceId: string;
  playerId: string;
  name: string;
  avatarUrl: string | null;
  isGuest?: boolean;
};

// 保存と反映待ちの記録は、呼び出し元の transaction に含めます。
export interface RoomStatePort {
  playerLabel(player: Room["players"][number]): string;
  readRoom(): Room | null;
  hasRoom(): boolean;
  saveRoom(room: Room): Room;
  initializeRoom(viewerSecret: string): void;
  clearRoom(): void;
  membership(hash: string): RoomMembership | null;
  hasMembership(hash: string): boolean;
  saveMembership(hash: string, membership: RoomMembership): void;
  deleteMembership(hash: string): void;
  playerToken(playerId: string): string | null;
  savePlayerToken(playerId: string, hash: string): void;
  deletePlayerToken(playerId: string): void;
  hasConnection(hash: string): boolean;
  disconnectedAt(playerId: string): number | undefined;
  saveDisconnectedAt(playerId: string, at: number): void;
  clearPlayerTransientState(playerId: string): void;
  clearClosedPlayerState(playerId: string): void;
  hasDeparted(playerId: string): boolean;
  saveDeparted(playerId: string): void;
  clearDeparted(playerId: string): void;
  isHumanParticipant(player: Room["players"][number]): boolean;
  registrationDeadline(playerId: string): number | undefined;
  expireRegistration(playerId: string): void;
  waitingTournament(room: Room): { expiresAt: number; connected: boolean } | null;
  hasCpuCapacity(room: Room): boolean;
  hasRegistration(playerId: string): boolean;
  releaseRegistration(playerId: string): void;
  releaseAccount(playerId: string, removeAvatar: boolean): void;
  saveAdmission(playerId: string): void;
  saveIdentity(playerId: string): void;
  deleteIdentity(playerId: string): void;
  appendSystem(event: SystemChatMessage["event"], text: string, at: number): void;
  closeReservations(room: Room | null): void;
  finishTournament(room: Room): void;
  excludeWaitingTournamentPlayer(room: Room, playerId: string): boolean;
  startMatchUsage(id: string, room: Room, at: number): RoomEffect[];
  endMatchUsage(
    status: "completed" | "abandoned",
    at: number,
    game?: FinishedFor<GameId>,
  ): RoomEffect[];
}

export interface RoomPorts {
  state: RoomStatePort;
  game<G extends GameId>(room: { settings: { game: G } }): RoomGamePort<G>;
}

export type RoomOperation = RoomPorts & { now: number; effects: RoomEffect[] };

export function runRoomUseCase<T>(
  ports: RoomPorts,
  now: number,
  action: (operation: RoomOperation) => T,
): RoomOutcome<T> {
  const operation: RoomOperation = { ...ports, now, effects: [] };
  const value = action(operation);
  return { value, effects: operation.effects };
}

export const reconnectGraceMs = 30_000;
export function nextPublicUpdateAt(room: Room, now: number): number {
  return Math.max(now, room.publicUpdatedAtMs + 1);
}

export function appendSystem(
  operation: RoomOperation,
  event: SystemChatMessage["event"],
  text: string,
): void {
  operation.state.appendSystem(event, text, operation.now);
  operation.effects.push({ type: "chatChanged" });
}

export function publishRoom(op: RoomOperation, room: Room | null): void {
  op.effects.push(room === null ? { type: "closeSockets" } : { type: "broadcastRoom", room });
}
