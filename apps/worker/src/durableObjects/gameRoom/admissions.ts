import * as roomUseCases from "@tetraboard/context-room";
import { joinRoomContract, roomSchema, type Room, type RoomMembership } from "@tetraboard/protocol";
import { type AccountAdmission } from "../../flows/accountSeats/types";
import { invokeRoomTransaction } from "../../adapters/room/useCaseTransaction";
import { roomAdmission } from "../../adapters/room/useCases";
import { withAccountAdmission } from "../../flows/accountSeats/admission";
import { type AnalyticsIdentity } from "../../usageEvents/matches";
import type { RoomRuntime } from "./runtime";

export async function createRoom(
  runtime: RoomRuntime,
  room: Room,
  tokenHash: string,
  admission?: AccountAdmission,
  analytics?: AnalyticsIdentity,
): Promise<Room | null> {
  await runtime.reconcileDeadlines();
  const initialRoom = roomSchema.parse(room);

  if (initialRoom.id !== runtime.ctx.id.name) {
    throw new Error("Room code does not match Durable Object name");
  }

  return withAccountAdmission(runtime, admission, () => {
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    return invokeRoomTransaction(
      runtime,
      (op) =>
        roomUseCases.createRoom(
          op,
          initialRoom,
          tokenHash,
          Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          roomAdmission(admission),
        ),
      { admission, analytics },
    );
  });
}

export async function joinRoom(
  runtime: RoomRuntime,
  name: string,
  tokenHash: string,
  instanceId?: string,
  admission?: AccountAdmission,
  analytics?: AnalyticsIdentity,
): Promise<
  | { status: "joined"; room: Room; membership: RoomMembership }
  | { status: "not_found" }
  | { status: "room_full" }
  | { status: "room_started" }
  | { status: "room_changed" }
  | { status: "account_reservation_invalid" }
  | { status: "tournament_required" }
  | { status: "matchmaking_required" }
> {
  await runtime.reconcileDeadlines();
  const playerName = joinRoomContract.request.parse({ name }).name!;
  const result = await withAccountAdmission(runtime, admission, () =>
    invokeRoomTransaction(
      runtime,
      (op) =>
        roomUseCases.joinRoom(
          op,
          playerName,
          tokenHash,
          admission?.playerId ?? crypto.randomUUID(),
          instanceId,
          roomAdmission(admission),
        ),
      { admission, analytics },
    ),
  );
  return result ?? { status: "account_reservation_invalid" };
}

export async function leaveRoom(
  runtime: RoomRuntime,
  tokenHash: string,
): Promise<"left" | "not_found" | "unauthorized"> {
  await runtime.reconcileDeadlines();
  const result = invokeRoomTransaction(runtime, (op) => roomUseCases.leaveRoom(op, tokenHash));
  if (result.status === "time_expired") {
    await runtime.reconcileDeadlines();
    return leaveRoom(runtime, tokenHash);
  }
  return result.status;
}
