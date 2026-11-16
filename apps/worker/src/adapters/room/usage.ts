import { roomMatchKind, type Room } from "@tetraboard/protocol";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { storedAccount } from "../../flows/accountSeats/seats";
import { clearMatchmakingSearches } from "../../flows/matchmakingRoom/reservations";
import type { MatchmakingRoomReservation } from "../../matchmaking/coordinator";
import {
  analyticsActiveKey,
  analyticsPlayerKey,
  type AnalyticsIdentity,
  type AnalyticsMatch,
} from "../../usageEvents/matches";
import { matchEndFacts } from "../../usageEvents/matchLifecycle";

export function startAnalyticsMatch(runtime: RoomRuntime, id: string, room: Room, at: number) {
  const reservation =
    "matchmaking" in room && room.matchmaking
      ? runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${room.matchmaking.id}`)
      : undefined;
  const record: AnalyticsMatch = analyticsMatch(runtime, id, room, at, reservation);
  writeMatchStarted(runtime, record);
  if (reservation)
    runtime.ctx.storage.kv.put(
      `matchmaking:${reservation.matchId}`,
      clearMatchmakingSearches(runtime, reservation),
    );
  runtime.ctx.storage.kv.put(analyticsActiveKey, record);
}

export function endAnalyticsMatch(
  runtime: RoomRuntime,
  status: "completed" | "abandoned",
  at: number,
  facts?: ReturnType<typeof matchEndFacts>,
) {
  const active = runtime.ctx.storage.kv.get<AnalyticsMatch>(analyticsActiveKey);
  if (!active) return;
  runtime.ctx.storage.kv.delete(analyticsActiveKey);
  runtime.usageEvents.writer().write({
    name: "match_ended",
    game: active.game,
    matchId: active.id,
    isTest: active.participants.length > 0 && active.participants.every((p) => p.isTest),
    result: status,
    reason: status === "abandoned" ? "abandoned" : (facts?.reason ?? "unknown"),
    durationMs: Math.max(0, at - active.startedAtMs),
  });
}

function analyticsMatch(
  runtime: RoomRuntime,
  id: string,
  room: Room,
  at: number,
  reservation: MatchmakingRoomReservation | undefined,
): AnalyticsMatch {
  return {
    id,
    matchKind: roomMatchKind(room),
    humanCount: room.players.filter((p) => p.kind === "human").length,
    game: room.settings.game,
    mode: room.settings.mode ?? "standard",
    startedAtMs: at,
    endedAtMs: null,
    status: "playing",
    cpuCount: room.players.filter((p) => p.kind === "cpu").length,
    participants: room.players
      .filter((p) => p.kind === "human")
      .map((p) => {
        const identity = runtime.ctx.storage.kv.get<AnalyticsIdentity>(analyticsPlayerKey(p.id));
        const search = reservation?.players.find(
          (player) => player.admission.playerId === p.id,
        )?.search;
        const playerId =
          identity && !identity.accountId && !identity.visitorId ? crypto.randomUUID() : p.id;
        return {
          ...(search
            ? { search: { operationId: search.operationId, joinedAtMs: search.joinedAtMs } }
            : {}),
          playerId,
          visitorId: identity?.visitorId ?? null,
          accountId: identity
            ? identity.accountId
            : (storedAccount(runtime, p.id)?.accountId ?? null),
          isTest: identity?.isTest ?? search?.isTest ?? false,
          isGuest: identity?.isGuest ?? storedAccount(runtime, p.id)?.isGuest ?? false,
        };
      }),
  };
}

function writeMatchStarted(runtime: RoomRuntime, record: AnalyticsMatch) {
  const usage = runtime.usageEvents.writer();
  const common = {
    game: record.game,
    matchId: record.id,
    isTest: record.participants.length > 0 && record.participants.every((p) => p.isTest),
  };
  usage.write({
    ...common,
    name: "match_started",
    mode: record.mode,
    matchKind: record.matchKind ?? "unknown",
    humans: record.humanCount ?? record.participants.length,
    cpus: record.cpuCount,
  });
  for (const participant of record.participants) {
    const identity = {
      game: record.game,
      browserId: participant.visitorId,
      accountId: participant.accountId,
      isTest: participant.isTest,
    };
    usage.write({
      ...identity,
      name: "match_participant",
      matchId: record.id,
      isGuest: participant.isGuest ?? false,
    });
    if (participant.accountId && participant.search)
      usage.write({
        ...identity,
        name: "matchmaking",
        operationId: participant.search.operationId,
        stage: "started",
        reason: null,
        rated: record.matchKind === "rated",
        humans: record.humanCount ?? record.participants.length,
      });
  }
}
