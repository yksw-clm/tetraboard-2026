import { storedAccount } from "../accountSeats/seats";
import { roomSchema, tournamentRules } from "@tetraboard/protocol";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import {
  membershipStorageKey,
  playerTokenKey,
  disconnectedAtKey,
  reconnectGraceMs,
} from "../../durableObjects/gameRoom/storageKeys";
import { closeSockets } from "../../durableObjects/gameRoom/connections";
import { broadcastRoom } from "../../durableObjects/gameRoom/snapshots";
import { roomStorageKey, nextPublicUpdateAt } from "../../rooms/progressHelpers";
import {
  tournamentReservationKey,
  tournamentCredentialVersionKey,
  isTournamentGameRoom,
  type TournamentRoomReservation,
  type RekeyTournamentPlayerInput,
  type TournamentReturn,
  type TournamentGameRoom,
} from "../../rooms/tournamentRoom";

export async function rekeyTournamentPlayer(
  runtime: RoomRuntime,
  input: RekeyTournamentPlayerInput,
) {
  if (
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    !/^[0-9a-f]{64}$/.test(input.tokenHash)
  )
    return { status: "stale" as const };
  let failure: unknown;
  const result = await runtime.ctx.blockConcurrencyWhile(async () => {
    try {
      return await rekeyReservedTournamentPlayer(runtime, input);
    } catch (error) {
      // RPCの一時失敗で、ほかの参加者の接続までリセットしないようにします。
      failure = error;
      return null;
    }
  });
  if (result === null) throw failure;
  return result;
}

async function rekeyReservedTournamentPlayer(
  runtime: RoomRuntime,
  input: RekeyTournamentPlayerInput,
) {
  const reservation = runtime.ctx.storage.kv.get<TournamentRoomReservation>(
    tournamentReservationKey(input.matchId),
  );
  const initial = runtime.readRoom();
  const seat = storedAccount(runtime, input.playerId);
  const resultWaiting =
    initial &&
    isTournamentGameRoom(initial) &&
    initial.status === "waiting" &&
    runtime.gameAdapter(initial).lastRoundId(initial) === input.matchId &&
    reservation?.startedAtMs !== undefined;
  if (
    !reservation ||
    !initial ||
    !isTournamentGameRoom(initial) ||
    initial.instanceId !== input.instanceId ||
    reservation.instanceId !== input.instanceId ||
    (reservation.status === "closed" && !resultWaiting) ||
    seat?.accountId !== input.accountId ||
    seat.operationId !== input.operationId ||
    !initial.players.some((player) => player.id === input.playerId)
  )
    return { status: "not_found" as const };
  const version =
    runtime.ctx.storage.kv.get<number>(tournamentCredentialVersionKey(input.playerId)) ?? 0;
  const previousHash = runtime.playerTokenHash(input.playerId);
  const collision = runtime.readMembership(input.tokenHash);
  if (collision && collision.playerId !== input.playerId) return { status: "stale" as const };
  if (input.version < version || (input.version === version && previousHash !== input.tokenHash))
    return { status: "stale" as const };
  if (input.version === version && previousHash === input.tokenHash)
    return { status: "updated" as const };
  return rekeyEligibleTournamentPlayer(runtime, input, reservation, initial, previousHash);
}

async function rekeyEligibleTournamentPlayer(
  runtime: RoomRuntime,
  input: RekeyTournamentPlayerInput,
  reservation: TournamentRoomReservation,
  initial: TournamentGameRoom,
  previousHash: string | null,
) {
  await runtime.syncAlarm();
  const eligible = await runtime.db
    .prepare(
      `SELECT 1 FROM account_room_seats s JOIN user u ON u.id=s.account_id JOIN tournament_match_players p ON p.operation_id=s.operation_id AND p.match_id=? JOIN tournament_entries e ON e.id=p.entry_id AND e.account_id=s.account_id AND e.deleted=0 WHERE s.account_id=? AND s.operation_id=? AND s.instance_id=? AND s.player_id=? AND u.profileCompleted=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)`,
    )
    .bind(input.matchId, input.accountId, input.operationId, input.instanceId, input.playerId)
    .first();
  if (!eligible) return { status: "not_found" as const };
  if (
    reservation.status === "waiting" &&
    Date.now() >=
      Math.min(
        reservation.preparedAtMs + tournamentRules.connectionGraceMs,
        reservation.context.endsAtMs,
      )
  ) {
    runtime.withIndexTransaction(() => runtime.closeRoom());
    closeSockets(runtime);
    return { status: "not_found" as const };
  }
  replaceTournamentCredential(runtime, input, reservation, initial, previousHash);
  notifyTournamentTransfer(runtime, input, reservation, previousHash);
  const room = runtime.readRoom();
  if (room) broadcastRoom(runtime, room);
  return { status: "updated" as const };
}

function replaceTournamentCredential(
  runtime: RoomRuntime,
  input: RekeyTournamentPlayerInput,
  reservation: TournamentRoomReservation,
  initial: TournamentGameRoom,
  previousHash: string | null,
) {
  runtime.withIndexTransaction(() => {
    const membership = previousHash ? runtime.readMembership(previousHash) : null;
    if (previousHash) runtime.ctx.storage.kv.delete(membershipStorageKey(previousHash));
    runtime.ctx.storage.kv.put(
      membershipStorageKey(input.tokenHash),
      membership ?? {
        playerId: input.playerId,
        role: initial.players[0]?.id === input.playerId ? "host" : "player",
      },
    );
    runtime.ctx.storage.kv.put(playerTokenKey(input.playerId), input.tokenHash);
    runtime.ctx.storage.kv.put(tournamentCredentialVersionKey(input.playerId), input.version);
    runtime.ctx.storage.kv.put(disconnectedAtKey(input.playerId), Date.now());
    const { tournamentStartsAtMs: _deadline, ...waiting } =
      initial.status === "waiting" ? initial : { ...initial, tournamentStartsAtMs: undefined };
    const next = roomSchema.parse({
      ...waiting,
      publicUpdatedAtMs: nextPublicUpdateAt(initial),
      players: initial.players.map((player) =>
        player.id === input.playerId
          ? {
              ...player,
              reconnectDeadline:
                player.reconnectDeadline ??
                (reservation.status === "waiting"
                  ? Math.min(
                      reservation.preparedAtMs + tournamentRules.connectionGraceMs,
                      reservation.context.endsAtMs,
                    )
                  : Date.now() + reconnectGraceMs),
            }
          : player,
      ),
    });
    runtime.ctx.storage.kv.put(roomStorageKey, next);
  });
}

function notifyTournamentTransfer(
  runtime: RoomRuntime,
  input: RekeyTournamentPlayerInput,
  reservation: TournamentRoomReservation,
  previousHash: string | null,
) {
  if (previousHash) {
    const notice: TournamentReturn = {
      type: "room.tournament.return",
      tournamentId: reservation.context.tournamentId,
      matchId: input.matchId,
      instanceId: input.instanceId,
      reason: "transferred",
    };
    for (const socket of runtime.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { tokenHash?: string } | null;
      if (attachment?.tokenHash === previousHash && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(notice));
        } catch {
          /* 切断済みなら新しい資格だけを有効にします。 */
        }
      }
    }
    closeSockets(runtime, previousHash, "Tournament control transferred");
  }
}
