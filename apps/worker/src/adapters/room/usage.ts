import type { MatchUsageEvent, RoomEffect } from "@tetraboard/context-room";
import { roomMatchKind, type Room } from "@tetraboard/protocol";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { storedAccount } from "../../flows/accountSeats/seats";
import { clearMatchmakingSearches } from "../../flows/matchmakingRoom/reservations";
import type { MatchmakingRoomReservation } from "@tetraboard/context-matchmaking";
import {
  analyticsActiveKey,
  analyticsPlayerKey,
  type AnalyticsIdentity,
  type AnalyticsMatch,
} from "../../usageEvents/matches";
import { matchEndFacts } from "../../usageEvents/matchLifecycle";

export function collectMatchStarted(
  runtime: RoomRuntime,
  id: string,
  room: Room,
  at: number,
): RoomEffect[] {
  const reservation =
    "matchmaking" in room && room.matchmaking
      ? runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(`matchmaking:${room.matchmaking.id}`)
      : undefined;
  const record: AnalyticsMatch = analyticsMatch(runtime, id, room, at, reservation);
  const effects = writeMatchStarted(record);
  if (reservation)
    runtime.ctx.storage.kv.put(
      `matchmaking:${reservation.matchId}`,
      clearMatchmakingSearches(runtime, reservation),
    );
  runtime.ctx.storage.kv.put(analyticsActiveKey, record);
  return effects;
}

export function collectMatchEnded(
  runtime: RoomRuntime,
  status: "completed" | "abandoned",
  at: number,
  facts?: ReturnType<typeof matchEndFacts>,
): RoomEffect[] {
  const active = runtime.ctx.storage.kv.get<AnalyticsMatch>(analyticsActiveKey);
  if (!active) return [];
  runtime.ctx.storage.kv.delete(analyticsActiveKey);
  return [
    {
      type: "usage",
      event: {
        name: "match_ended",
        game: active.game,
        matchId: active.id,
        isTest: active.participants.length > 0 && active.participants.every((p) => p.isTest),
        result: status,
        reason: status === "abandoned" ? "abandoned" : (facts?.reason ?? "unknown"),
        durationMs: Math.max(0, at - active.startedAtMs),
      },
    },
  ];
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

function writeMatchStarted(record: AnalyticsMatch): RoomEffect[] {
  const effects: RoomEffect[] = [];
  const usage = { write: (event: MatchUsageEvent) => effects.push({ type: "usage", event }) };
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
  return effects;
}

export function startAnalyticsMatch(
  runtime: RoomRuntime,
  id: string,
  room: Room,
  at: number,
): void {
  runtime.effects.publish(collectMatchStarted(runtime, id, room, at));
}
export function endAnalyticsMatch(
  runtime: RoomRuntime,
  status: "completed" | "abandoned",
  at: number,
  facts?: ReturnType<typeof matchEndFacts>,
): void {
  runtime.effects.publish(collectMatchEnded(runtime, status, at, facts));
}
