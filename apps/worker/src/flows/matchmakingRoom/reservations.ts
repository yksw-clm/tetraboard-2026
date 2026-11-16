import { storedAccount } from "../accountSeats/seats";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import type { MatchmakingRoomReservation } from "../../matchmaking/coordinator";
import type { RoomPublicMetadata } from "@tetraboard/protocol";
import { hasOpenConnection } from "../../durableObjects/gameRoom/socket/membership";
import { closeSockets } from "../../durableObjects/gameRoom/connections";

export function clearMatchmakingSearches(
  _runtime: RoomRuntime,
  reservation: MatchmakingRoomReservation,
) {
  return {
    ...reservation,
    players: reservation.players.map(({ search: _search, ...player }) => player),
  };
}

export async function getMatchmakingState(
  runtime: RoomRuntime,
  matchId: string,
  instanceId: string,
) {
  await runtime.reconcileDeadlines();
  const saved = runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${matchId}`);
  const room = runtime.readRoom();
  const same = Boolean(
    room &&
    "matchmaking" in room &&
    room.matchmaking?.id === matchId &&
    room.instanceId === instanceId,
  );
  const occupiedPlayerIds = same
    ? room!.players
        .filter((p) => p.kind === "human" && storedAccount(runtime, p.id)?.occupying)
        .map((p) => p.id)
    : [];
  const connectedPlayerIds = same
    ? room!.players
        .filter(
          (p) =>
            p.kind === "human" && hasOpenConnection(runtime, runtime.playerTokenHash(p.id) ?? ""),
        )
        .map((p) => p.id)
    : (saved?.connectedPlayerIds ?? []);
  let summary: (RoomPublicMetadata & { instanceId: string }) | undefined;
  if (same) {
    const {
      hostPlayerId: _host,
      participantPreviews: _players,
      matchKind: _matchKind,
      ...metadata
    } = runtime.publicMetadata(room!);
    summary = metadata;
  }
  return {
    phase: same ? (saved?.phase ?? "closed") : "closed",
    started: saved?.phase === "playing",
    aiUnavailable: saved?.aiWarmup?.state === "failed",
    occupiedPlayerIds,
    connectedPlayerIds,
    ...(summary ? { room: summary } : {}),
  };
}

export async function abortMatchmakingRoom(
  runtime: RoomRuntime,
  matchId: string,
  instanceId: string,
) {
  await runtime.reconcileDeadlines();
  const reservation = runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(
    `matchmaking:${matchId}`,
  );
  if (reservation?.phase === "playing") return { status: "already_started" as const };
  const closed = runtime.withIndexTransaction(() => {
    runtime.ctx.storage.kv.put(`matchmaking-cancelled:${matchId}`, true);
    const room = runtime.readRoom();
    if (
      room &&
      "matchmaking" in room &&
      room.matchmaking?.id === matchId &&
      room.instanceId === instanceId
    ) {
      runtime.closeRoom();
      return true;
    }
    return false;
  });
  if (closed) closeSockets(runtime);
  return { status: "aborted" as const };
}
