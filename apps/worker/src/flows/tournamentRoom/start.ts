import { roomSchema, tournamentRules } from "@tetraboard/protocol";
import { playerTokenHash, readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { startAnalyticsMatch } from "../../adapters/room/usage";
import { closeRoom } from "../../adapters/room/useCases";
import { closeSockets } from "../../durableObjects/gameRoom/connections";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { broadcastRoom } from "../../durableObjects/gameRoom/snapshots";
import { hasOpenConnection } from "../../durableObjects/gameRoom/socket/membership";
import { nextPublicUpdateAt, roomStorageKey } from "../../adapters/room/games/progressHelpers";
import {
  isTournamentGameRoom,
  tournamentReservationKey,
  type TournamentGameRoom,
  type TournamentRoomReservation,
} from "@tetraboard/context-tournament";
import { readTournament, tournamentSettingsMatch } from "../../adapters/tournament/store";
import { recordTournamentState, tournamentReservation } from "./reservations";

export function tournamentPlayersConnected(
  runtime: RoomRuntime,
  room: TournamentGameRoom,
): boolean {
  return (
    room.players.length === 4 &&
    room.players.every((player) => {
      const hash = playerTokenHash(runtime, player.id);
      return player.kind === "human" && !!hash && hasOpenConnection(runtime, hash);
    })
  );
}

export async function advanceTournamentStart(runtime: RoomRuntime, initial = readRoom(runtime)) {
  const reservation = tournamentReservation(runtime, initial);
  if (
    !reservation ||
    reservation.status !== "waiting" ||
    !initial ||
    !isTournamentGameRoom(initial) ||
    initial.status !== "waiting"
  )
    return;
  const countdown = updateTournamentCountdown(runtime);
  if (countdown?.tournamentStartsAtMs === undefined || countdown.tournamentStartsAtMs > Date.now())
    return;
  await runtime.ctx.blockConcurrencyWhile(async () => {
    await startReservedTournamentRoom(runtime, reservation, countdown);
  });
  const room = readRoom(runtime);
  if (room) broadcastRoom(runtime, room);
}

function updateTournamentCountdown(runtime: RoomRuntime) {
  let countdownChanged = false;
  const countdown = withIndexTransaction(runtime, (room) => {
    if (!room || !isTournamentGameRoom(room) || room.status !== "waiting") return null;
    const connected = tournamentPlayersConnected(runtime, room);
    if (connected && room.tournamentStartsAtMs !== undefined) return room;
    if (!connected && room.tournamentStartsAtMs === undefined) return null;
    const { tournamentStartsAtMs: _deadline, ...waiting } = room;
    const next = roomSchema.parse({
      ...waiting,
      ...(connected ? { tournamentStartsAtMs: Date.now() + tournamentRules.startCountdownMs } : {}),
      publicUpdatedAtMs: nextPublicUpdateAt(room),
    });
    runtime.ctx.storage.kv.put(roomStorageKey, next);
    countdownChanged = true;
    return next.status === "waiting" && isTournamentGameRoom(next) && connected ? next : null;
  });
  if (countdownChanged) {
    const room = readRoom(runtime);
    if (room) broadcastRoom(runtime, room);
  }
  return countdown;
}

async function startReservedTournamentRoom(
  runtime: RoomRuntime,
  reservation: TournamentRoomReservation,
  countdown: TournamentGameRoom & { status: "waiting" },
) {
  await runtime.alarms.sync();
  const active = await countActiveTournamentPlayers(runtime, reservation);
  const definition = await readTournament(runtime.db, reservation.context.tournamentKey);
  const now = Date.now();
  if (
    !definition ||
    !tournamentSettingsMatch(definition, reservation.context) ||
    active?.count !== 4 ||
    now < reservation.context.startsAtMs ||
    now >= reservation.context.endsAtMs ||
    now >= reservation.preparedAtMs + tournamentRules.connectionGraceMs
  ) {
    const closed = withIndexTransaction(runtime, (room) => {
      if (!room || room.instanceId !== reservation.instanceId) return false;
      closeRoom(runtime);
      return true;
    });
    if (closed) closeSockets(runtime);
    return;
  }
  startTournamentGame(runtime, reservation, countdown);
}

async function countActiveTournamentPlayers(
  runtime: RoomRuntime,
  reservation: TournamentRoomReservation,
) {
  return runtime.db
    .prepare(`SELECT COUNT(*) AS count FROM tournament_match_players p
        JOIN account_room_seats s ON s.account_id=p.account_id AND s.operation_id=p.operation_id AND s.player_id=p.player_id
        JOIN tournament_entries e ON e.id=p.entry_id AND e.account_id=p.account_id AND e.deleted=0
        JOIN user u ON u.id=p.account_id
        JOIN tournament_matches m ON m.id=p.match_id
        JOIN tournaments t ON t.key=m.tournament_key
        WHERE p.match_id=? AND m.phase='reserved' AND m.tournament_key=? AND m.room_id=? AND m.instance_id=?
          AND s.room_id=? AND s.instance_id=? AND u.profileCompleted=1
          AND t.published=1 AND t.public_id=? AND t.rule_version=? AND t.starts_at_ms=? AND t.ends_at_ms=?
          AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=p.account_id)`)
    .bind(
      reservation.context.matchId,
      reservation.context.tournamentKey,
      reservation.roomId,
      reservation.instanceId,
      reservation.roomId,
      reservation.instanceId,
      reservation.context.tournamentId,
      reservation.context.ruleVersion,
      reservation.context.startsAtMs,
      reservation.context.endsAtMs,
    )
    .first<{ count: number }>();
}

function startTournamentGame(
  runtime: RoomRuntime,
  reservation: TournamentRoomReservation,
  countdown: TournamentGameRoom & { status: "waiting" },
) {
  withIndexTransaction(runtime, (room) => {
    if (
      !room ||
      !isTournamentGameRoom(room) ||
      room.status !== "waiting" ||
      room.instanceId !== reservation.instanceId
    )
      return;
    if (!tournamentPlayersConnected(runtime, room)) {
      const { tournamentStartsAtMs: _deadline, ...waiting } = room;
      runtime.ctx.storage.kv.put(roomStorageKey, {
        ...waiting,
        publicUpdatedAtMs: nextPublicUpdateAt(room),
      });
      return;
    }
    if (
      room.tournamentStartsAtMs === undefined ||
      room.tournamentStartsAtMs !== countdown.tournamentStartsAtMs ||
      room.tournamentStartsAtMs > Date.now()
    )
      return;
    if (
      Date.now() >= reservation.context.endsAtMs ||
      Date.now() >= reservation.preparedAtMs + tournamentRules.connectionGraceMs
    ) {
      closeRoom(runtime);
      return;
    }
    const started = runtime.gameAdapter(room).start(room, {
      kind: "tournament",
      tournament: reservation.context,
    });
    const playing: TournamentRoomReservation = {
      ...reservation,
      status: "playing",
      startedAtMs: started.at,
    };
    runtime.ctx.storage.kv.put(tournamentReservationKey(reservation.context.matchId), playing);
    recordTournamentState(runtime, playing, "playing");
    startAnalyticsMatch(runtime, started.roundId, started.room, started.at);
  });
}
