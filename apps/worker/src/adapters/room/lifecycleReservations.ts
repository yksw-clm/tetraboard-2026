import type { Room } from "@tetraboard/protocol";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { hasOpenConnection } from "../../durableObjects/gameRoom/socket/membership";
import { clearMatchmakingSearches } from "../../flows/matchmakingRoom/reservations";
import {
  recordTournamentState,
  tournamentReservation,
} from "../../flows/tournamentRoom/reservations";
import type { MatchmakingRoomReservation } from "../../matchmaking/coordinator";
import {
  tournamentReservationKey,
  tournamentReturnKey,
  tournamentRoomKey,
  type TournamentReturn,
} from "../../rooms/tournamentRoom";
import { playerTokenHash } from "./state";

export function closeReservations(runtime: RoomRuntime, room: Room | null): void {
  closeMatchmaking(runtime, room);
  closeTournament(runtime, room);
}

function closeMatchmaking(runtime: RoomRuntime, room: Room | null): void {
  if (room && "matchmaking" in room && room.matchmaking) {
    const key = `matchmaking:${room.matchmaking.id}`;
    const saved = runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(key);
    if (saved && saved.phase !== "playing")
      runtime.ctx.storage.kv.put(key, {
        ...clearMatchmakingSearches(runtime, saved),
        phase: "closed",
        connectedPlayerIds: room.players
          .filter(
            (p) =>
              p.kind === "human" &&
              hasOpenConnection(runtime, playerTokenHash(runtime, p.id) ?? ""),
          )
          .map((p) => p.id),
      });
  }
}

function closeTournament(runtime: RoomRuntime, room: Room | null): void {
  const tournament = tournamentReservation(runtime, room);
  if (tournament) {
    const excluded = tournament.excludedPlayerIds ?? [];
    const connectedPlayerIds =
      room?.players
        .filter((player) => {
          const hash = playerTokenHash(runtime, player.id);
          return !excluded.includes(player.id) && hash !== null && hasOpenConnection(runtime, hash);
        })
        .map((player) => player.id) ?? [];
    const closed = { ...tournament, status: "closed" as const, connectedPlayerIds };
    runtime.ctx.storage.kv.put(tournamentReservationKey(tournament.context.matchId), closed);
    if (tournament.status === "waiting") {
      const returns: Record<string, TournamentReturn> = {};
      for (const player of room?.players ?? []) {
        const hash = playerTokenHash(runtime, player.id);
        if (hash)
          returns[hash] = {
            type: "room.tournament.return",
            tournamentId: tournament.context.tournamentId,
            matchId: tournament.context.matchId,
            instanceId: tournament.instanceId,
            reason: excluded.includes(player.id) ? "left" : "unavailable",
          };
      }
      runtime.ctx.storage.kv.put(tournamentReturnKey, returns);
    }
    if (tournament.status !== "closed") recordTournamentState(runtime, closed, "aborted");
    runtime.ctx.storage.kv.delete(tournamentRoomKey);
  }
}

export function finishTournament(runtime: RoomRuntime, room: Room): void {
  const tournament = tournamentReservation(runtime, room);
  if (!tournament) return;
  const closed = { ...tournament, status: "closed" as const };
  runtime.ctx.storage.kv.put(tournamentReservationKey(tournament.context.matchId), closed);
  recordTournamentState(runtime, closed, "saving");
}

export function excludeWaitingTournamentPlayer(
  runtime: RoomRuntime,
  room: Room,
  playerId: string,
): boolean {
  const tournament = tournamentReservation(runtime, room);
  if (tournament?.status !== "waiting") return false;
  runtime.ctx.storage.kv.put(tournamentReservationKey(tournament.context.matchId), {
    ...tournament,
    excludedPlayerIds: [...new Set([...(tournament.excludedPlayerIds ?? []), playerId])],
  });
  return true;
}
