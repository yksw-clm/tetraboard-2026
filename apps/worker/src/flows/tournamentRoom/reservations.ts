import { playerTokenHash, readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { closeRoom } from "../../adapters/room/useCases";
import { closeSockets } from "../../durableObjects/gameRoom/connections";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { hasOpenConnection } from "../../durableObjects/gameRoom/socket/membership";
import {
  cancelledTournamentKey,
  pendingTournamentStatePrefix,
  tournamentReservationKey,
  tournamentRoomKey,
  type PendingTournamentState,
  type TournamentRoomReservation,
} from "../../rooms/tournamentRoom";

export function tournamentReservation(
  runtime: RoomRuntime,
  room = readRoom(runtime),
): TournamentRoomReservation | null {
  const matchId = runtime.ctx.storage.kv.get<string>(tournamentRoomKey);
  const reservation = matchId
    ? runtime.ctx.storage.kv.get<TournamentRoomReservation>(tournamentReservationKey(matchId))
    : undefined;
  return room && reservation?.instanceId === room.instanceId ? reservation : null;
}

export function recordTournamentState(
  runtime: RoomRuntime,
  reservation: TournamentRoomReservation,
  phase: PendingTournamentState["phase"],
) {
  runtime.ctx.storage.kv.put(pendingTournamentStatePrefix + reservation.context.matchId, {
    reservation,
    phase,
    retryAtMs: Date.now(),
  } satisfies PendingTournamentState);
}

export function updatePendingTournamentState(
  runtime: RoomRuntime,
  key: string,
  job: PendingTournamentState,
  retryAtMs?: number,
) {
  runtime.ctx.storage.transactionSync(() => {
    const current = runtime.ctx.storage.kv.get<PendingTournamentState>(key);
    if (current?.phase !== job.phase || current.retryAtMs !== job.retryAtMs) return;
    if (retryAtMs !== undefined) runtime.ctx.storage.kv.put(key, { ...current, retryAtMs });
    else runtime.ctx.storage.kv.delete(key);
  });
}

export async function getTournamentReservationState(runtime: RoomRuntime, matchId: string) {
  await runtime.reconcileDeadlines();
  const reservation = runtime.ctx.storage.kv.get<TournamentRoomReservation>(
    tournamentReservationKey(matchId),
  );
  const room = readRoom(runtime);
  const connectedPlayerIds =
    reservation?.status === "waiting" && room?.instanceId === reservation.instanceId
      ? room.players
          .filter((player) => {
            const hash = playerTokenHash(runtime, player.id);
            return hash !== null && hasOpenConnection(runtime, hash);
          })
          .map((player) => player.id)
      : (reservation?.connectedPlayerIds ?? []);
  return reservation
    ? {
        status: reservation.status,
        connectedPlayerIds,
        ...(reservation.startedAtMs !== undefined ? { startedAtMs: reservation.startedAtMs } : {}),
      }
    : { status: "closed" as const, connectedPlayerIds: [] as string[] };
}

export async function abortTournamentRoom(
  runtime: RoomRuntime,
  matchId: string,
  excludedPlayerIds: string[] = [],
) {
  await runtime.reconcileDeadlines();
  const reservation = runtime.ctx.storage.kv.get<TournamentRoomReservation>(
    tournamentReservationKey(matchId),
  );
  if (reservation?.startedAtMs !== undefined) return { status: "already_started" as const };
  let closed = false;
  withIndexTransaction(runtime, (room) => {
    runtime.ctx.storage.kv.put(cancelledTournamentKey(matchId), true);
    if (reservation && room?.instanceId === reservation.instanceId) {
      runtime.ctx.storage.kv.put(tournamentReservationKey(matchId), {
        ...reservation,
        excludedPlayerIds: [
          ...new Set([...(reservation.excludedPlayerIds ?? []), ...excludedPlayerIds]),
        ],
      });
      closeRoom(runtime);
      closed = true;
    }
  });
  if (closed) closeSockets(runtime);
  return { status: "cancelled" as const };
}
