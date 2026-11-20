import {
  getRoomContract,
  getRoomMembershipContract,
  type createRoomContract,
  type RoomMembership,
} from "@tetraboard/protocol";
import { readRoomMembershipToken } from "./roomMembership";

type EntryResponse = ReturnType<typeof createRoomContract.response.parse>;
type InitialRoomData = { snapshot?: unknown; currentMembership?: unknown };
type RoomEntryHandoff = {
  roomId: string;
  token: string;
  snapshot: ReturnType<typeof getRoomContract.response.parse>;
  currentMembership: RoomMembership;
  receivedAt: number;
};

let pending: RoomEntryHandoff | undefined;

export function splitRoomEntryResponse(body: unknown): {
  entry: unknown;
  initial: InitialRoomData;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { entry: body, initial: {} };
  }
  const { snapshot, currentMembership, ...entry } = body as Record<string, unknown>;
  return { entry, initial: { snapshot, currentMembership } };
}

export function saveRoomEntryHandoff(
  { room, membership }: EntryResponse,
  initial: InitialRoomData,
  receivedAt: number,
): void {
  pending = undefined;
  if (initial.snapshot === undefined || initial.currentMembership === undefined) return;
  const { data: snapshot } = getRoomContract.response.safeParse(initial.snapshot);
  const { data: currentMembership } = getRoomMembershipContract.response.safeParse(
    initial.currentMembership,
  );
  if (
    !snapshot ||
    !currentMembership ||
    snapshot.room.id !== room.id ||
    snapshot.room.instanceId !== room.instanceId ||
    currentMembership.playerId !== membership.playerId ||
    currentMembership.role !== membership.role
  ) {
    return;
  }
  pending = { roomId: room.id, token: membership.token, snapshot, currentMembership, receivedAt };
}

export function takeRoomEntryHandoff(roomId: string): RoomEntryHandoff | undefined {
  const entry = pending;
  pending = undefined;
  if (
    entry?.roomId === roomId &&
    readRoomMembershipToken(roomId) === entry.token &&
    performance.now() - entry.receivedAt <= 10_000
  ) {
    return entry;
  }
}
