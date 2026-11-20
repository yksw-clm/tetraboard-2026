import { type Room, type RoomMembership } from "@tetraboard/protocol";
import { refreshLobbyIndex as refreshIndex } from "../../adapters/room/indexJob";
import { publicMetadata } from "../../adapters/room/metadata";
import { currentRoomMembership, readRoom } from "../../adapters/room/state";
import { roomFormationAnalysis } from "../../adapters/record/fourShogiFormationAnalysis";
import type { RoomRuntime } from "./runtime";
import { presence } from "./snapshots";

export async function getFourShogiAnalysisReplay(
  runtime: RoomRuntime,
  instanceId: string,
  roundId: string,
  positionRevision: number,
  cursor: number,
): Promise<
  | { status: "found"; page: import("@tetraboard/protocol").FourShogiAnalysisReplayPage }
  | { status: "not_found" | "room_changed" | "stale_position" }
> {
  await runtime.reconcileDeadlines();
  const room = readRoom(runtime);
  if (!room) return { status: "not_found" };
  if (room.instanceId !== instanceId) return { status: "room_changed" };
  return runtime.gameAdapter(room).analysisReplay(room, roundId, positionRevision, cursor);
}

export async function getShogiReplay(
  runtime: RoomRuntime,
  instanceId: string,
  roundId: string,
  cursor: number,
): Promise<
  | {
      status: "found";
      page:
        | import("@tetraboard/protocol").FourShogiReplayPage
        | import("@tetraboard/protocol").ShogiReplayPage;
    }
  | { status: "not_found" | "room_changed" }
> {
  await runtime.reconcileDeadlines();
  const room = readRoom(runtime);
  if (!room) return { status: "not_found" };
  if (room.instanceId !== instanceId) return { status: "room_changed" };
  return runtime.gameAdapter(room).replay(room, roundId, cursor);
}

export async function getRoom(runtime: RoomRuntime): Promise<Room | null> {
  await runtime.reconcileDeadlines();
  return readRoom(runtime);
}

export async function getRoomSnapshot(
  runtime: RoomRuntime,
  formationAnalysis = false,
  stamps = false,
  eliminatedHands = false,
) {
  const room = await getRoom(runtime);
  return room === null
    ? null
    : roomSnapshot(runtime, room, formationAnalysis, stamps, eliminatedHands);
}

function roomSnapshot(
  runtime: RoomRuntime,
  room: Room,
  formationAnalysis: boolean,
  stamps: boolean,
  eliminatedHands: boolean,
) {
  return {
    room,
    presence: presence(runtime, room),
    serverNowMs: Date.now(),
    ...roomFormationAnalysis(room, formationAnalysis),
    ...runtime.gameAdapter(room).displayHands(room, eliminatedHands),
    ...(stamps ? { stampsSupported: true as const } : {}),
  };
}

export async function getRoomEntrySnapshot(runtime: RoomRuntime, tokenHash: string) {
  const room = await getRoom(runtime);
  if (room === null) return null;
  const result = currentRoomMembership(runtime, tokenHash, room);
  if (result.status !== "found") return null;
  return {
    // Web の fetchRoom と同じ ?stamps=1&eliminatedHands=1 で読み取ります。
    snapshot: roomSnapshot(runtime, room, false, true, true),
    currentMembership: result.membership,
  };
}

export async function getPublicMetadata(runtime: RoomRuntime, profilePreview = false) {
  await runtime.reconcileDeadlines();
  const room = readRoom(runtime);
  if (room === null) return null;
  const {
    instanceId,
    hostPlayerId,
    participantPreviews: _previews,
    matchKind: _matchKind,
    matchSequence: _matchSequence,
    ...metadata
  } = publicMetadata(runtime, room);
  return { ...metadata, ...(profilePreview ? { instanceId, hostPlayerId } : {}) };
}

export async function getRoomMembership(
  runtime: RoomRuntime,
  tokenHash: string,
): Promise<
  | { status: "found"; membership: RoomMembership }
  | { status: "not_found" }
  | { status: "unauthorized" }
> {
  await runtime.reconcileDeadlines();
  return currentRoomMembership(runtime, tokenHash);
}

export async function refreshLobbyIndex(
  runtime: RoomRuntime,
  expectedInstanceId: string | null,
  expectedRevision: number,
) {
  await runtime.reconcileDeadlines();
  return refreshIndex(runtime, expectedInstanceId, expectedRevision);
}
