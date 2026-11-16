import {
  cpuPlayerAppearance,
  roomMatchKind,
  roomPublicMetadataSchema,
  type MatchKind,
  type Room,
  type RoomPublicMetadata,
} from "@tetraboard/protocol";
import { gameCapacity } from "@tetraboard/protocol/games";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { tournamentReservation } from "../../flows/tournamentRoom/reservations";
import type { MatchmakingRoomReservation } from "../../matchmaking/coordinator";
import { type IndexedRoomParticipant } from "../../rooms/roomIndex";
import { isTournamentGameRoom } from "../../rooms/tournamentRoom";
import { playerTokenHash, readMembership } from "./state";

export function publicMetadata(
  runtime: RoomRuntime,
  room: Room,
): RoomPublicMetadata & {
  matchKind: MatchKind;
  matchSequence?: number;
  instanceId: string;
  hostPlayerId: string | null;
  participantPreviews: IndexedRoomParticipant[];
} {
  const host = metadataHost(runtime, room);
  const kind = roomMatchKind(room);
  const matchmaking =
    "matchmaking" in room && room.matchmaking
      ? runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${room.matchmaking.id}`)
      : undefined;
  const matchSequence =
    kind === "tournament"
      ? tournamentReservation(runtime, room)?.context.matchSequence
      : kind === "rated" && matchmaking?.instanceId === room.instanceId
        ? matchmaking.matchSequence
        : undefined;
  const humanCount = room.players.filter((player) => player.kind === "human").length;
  return {
    instanceId: room.instanceId,
    matchKind: kind,
    ...(matchSequence === undefined ? {} : { matchSequence }),
    hostPlayerId: host?.id ?? null,
    participantPreviews: room.players.map((player) => ({
      playerId: player.id,
      appearance:
        player.kind === "cpu"
          ? cpuPlayerAppearance(player)
          : {
              kind: "human",
              avatarUrl: player.retired ? null : player.avatarUrl,
              ...(player.retired ? { retired: true as const } : {}),
            },
    })),
    ...roomPublicMetadataSchema.parse({
      id: room.id,
      ...("matchmaking" in room && room.matchmaking ? { matchmaking: true } : {}),
      ...(isTournamentGameRoom(room) && room.tournamentId !== undefined
        ? { tournamentId: room.tournamentId }
        : {}),
      game: room.settings.game,
      mode: room.settings.mode,
      timeControl: room.settings.timeControl,
      status: room.status,
      hostName: host?.name ?? null,
      hostAvatarUrl: host?.kind === "human" ? host.avatarUrl : null,
      humanCount,
      cpuCount: room.players.length - humanCount,
      capacity: gameCapacity(room.settings.game),
      openSeats:
        room.status === "waiting" ? gameCapacity(room.settings.game) - room.players.length : 0,
      updatedAtMs: room.publicUpdatedAtMs,
    }),
  };
}

function metadataHost(runtime: RoomRuntime, room: Room) {
  return room.players.find((player) => {
    if (player.kind !== "human" || player.retired) return false;
    const tokenHash = playerTokenHash(runtime, player.id);
    return tokenHash !== null && readMembership(runtime, tokenHash)?.role === "host";
  });
}
