import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import type { MatchmakingRoomReservation } from "../../matchmaking/coordinator";
import { startMatchmakingAiWarmup } from "./warmup";
import { matchmakingRules } from "@tetraboard/protocol";
import { gameCapacity } from "@tetraboard/protocol/games";
import { hasOpenConnection } from "../../durableObjects/gameRoom/socket/membership";
import { closeSockets } from "../../durableObjects/gameRoom/connections";
import { broadcastRoom } from "../../durableObjects/gameRoom/snapshots";
import { roomStorageKey, nextPublicUpdateAt } from "../../rooms/progressHelpers";

export async function advanceMatchmakingStart(runtime: RoomRuntime) {
  const current = runtime.readRoom();
  if (
    !current ||
    !("matchmaking" in current) ||
    !current.matchmaking ||
    current.status !== "waiting" ||
    current.lastRound
  )
    return;
  let reservation = runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(
    `matchmaking:${current.matchmaking.id}`,
  );
  if (!reservation || reservation.phase !== "waiting") return;
  if (reservation.aiWarmup) {
    const connected = current.players
      .filter((p) => p.kind === "human")
      .every((p) => hasOpenConnection(runtime, runtime.playerTokenHash(p.id) ?? ""));
    if (connected !== Boolean(reservation.aiHumansConnected)) {
      reservation = { ...reservation, aiHumansConnected: connected };
      runtime.ctx.storage.kv.put(`matchmaking:${reservation.matchId}`, reservation);
      if (connected)
        console.info({
          event: "rated_ai_all_connected",
          game: current.settings.game,
          matchId: reservation.matchId,
          atMs: Date.now(),
        });
    }
    if (reservation.aiWarmup?.state === "pending") {
      startMatchmakingAiWarmup(runtime, reservation);
      runtime.markAlarm();
      if (!runtime.readRoom()) closeSockets(runtime);
      return;
    }
  }
  const readyReservation = reservation;
  const diagnostic = runtime.withIndexTransaction(() =>
    startConnectedMatchmakingRoom(runtime, readyReservation),
  );
  if (diagnostic)
    runtime
      .gameAdapter(current)
      .matchmakingDiagnostic(
        readyReservation.rating,
        readyReservation.matchId,
        diagnostic.event,
        diagnostic.atMs,
      );
  const room = runtime.readRoom();
  runtime.markAlarm();
  if (room) broadcastRoom(runtime, room);
  else closeSockets(runtime);
}

function startConnectedMatchmakingRoom(
  runtime: RoomRuntime,
  readyReservation: MatchmakingRoomReservation,
) {
  const room = runtime.readRoom();
  if (
    !room ||
    !("matchmaking" in room) ||
    !room.matchmaking ||
    room.status !== "waiting" ||
    room.lastRound
  )
    return;
  if (
    Date.now() >= readyReservation.expiresAtMs ||
    room.players.length !== gameCapacity(room.settings.game)
  ) {
    runtime.closeRoom();
    return;
  }
  const connected = room.players
    .filter((p) => p.kind === "human")
    .every((p) => hasOpenConnection(runtime, runtime.playerTokenHash(p.id) ?? ""));
  if (!connected) {
    if (room.matchmaking.startsAtMs !== undefined) {
      const { startsAtMs: _deadline, ...metadata } = room.matchmaking;
      runtime.ctx.storage.kv.put(roomStorageKey, {
        ...room,
        matchmaking: metadata,
        publicUpdatedAtMs: nextPublicUpdateAt(room),
      });
      return { event: "four_shogi_countdown_reset", atMs: Date.now() };
    }
    return;
  }
  const deadline = room.matchmaking.startsAtMs;
  if (deadline === undefined) {
    const atMs = Date.now();
    runtime.ctx.storage.kv.put(roomStorageKey, {
      ...room,
      matchmaking: {
        ...room.matchmaking,
        startsAtMs: atMs + matchmakingRules.countdownMs,
      },
      publicUpdatedAtMs: nextPublicUpdateAt(room),
    });
    return { event: "four_shogi_connected", atMs };
  }
  if (Date.now() < deadline) return;
  const started = runtime.gameAdapter(room).start(room, {
    kind: "matchmaking",
    rating: readyReservation.rating,
  });
  runtime.ctx.storage.kv.put(`matchmaking:${room.matchmaking.id}`, {
    ...readyReservation,
    phase: "playing",
  } satisfies MatchmakingRoomReservation);
  runtime.startAnalyticsMatch(started.roundId, started.room, started.at);
  return { event: "four_shogi_started", atMs: started.at };
}
