import type { MatchmakingRuntime } from "@tetraboard/context-matchmaking";
import { matchmakingQueues, matchmakingRules, type MatchmakingGame } from "@tetraboard/protocol";
import { releaseReservation } from "../room/seatReservations";
import { reserveMatchSequence } from "../../rooms/matchSequences";
import { logFourShogiDiagnostic } from "../../fourShogiDiagnostics";
import { createUsageEventWriter } from "../../usageEvents/writer";
import { DurableMatchmakingStorage } from "./storage";
import { D1MatchmakingStore } from "./store";
import { matchmakingCredential } from "./credential";
import { ratedMatchmakingPolicy } from "./ratedMatchmaking";
export function createMatchmakingRuntime(ctx: DurableObjectState, env: Env): MatchmakingRuntime {
  const game =
    (Object.keys(matchmakingQueues) as MatchmakingGame[]).find(
      (game) => matchmakingQueues[game].key === ctx.id.name,
    ) ?? "four-reversi";
  const legacy = ctx.id.name === matchmakingRules.key;
  const ratingPolicy = legacy ? undefined : ratedMatchmakingPolicy(game);
  const writer = createUsageEventWriter(env.USAGE_EVENTS);
  return {
    game,
    legacy,
    retired: legacy && env.MATCHMAKING_ENABLED === "true",
    diagnostics: env.FOUR_SHOGI_DIAGNOSTICS === "true",
    legacyKey: matchmakingRules.key,
    queueRules: legacy ? matchmakingRules : matchmakingQueues[game],
    ratingPolicy,
    storage: new DurableMatchmakingStorage(ctx.storage),
    store: new D1MatchmakingStore(env.APP_DB, ratingPolicy),
    credential: (wait, key) => matchmakingCredential(env, wait, key),
    releaseReservation: (admission) => releaseReservation(env, admission, true),
    reserveMatchSequence: (id, scope) => reserveMatchSequence(env.APP_DB, id, scope),
    room: (roomId) => env.GAME_ROOM.getByName(roomId),
    availableCpuSeats: () => env.CPU_CAPACITY.getByName(game).availableSeats(),
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
    randomRoomId: () =>
      String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100000).padStart(5, "0"),
    event(wait, stage, reason = null, group) {
      writer.write({
        name: "matchmaking",
        operationId: wait.operationId,
        accountId: wait.accountId,
        game,
        stage,
        reason,
        waitingMs: stage === "matched" ? Math.max(0, Date.now() - wait.joinedAtMs) : null,
        humans: group?.players.length ?? null,
        rated: Boolean(ratingPolicy),
        isTest: wait.isTest ?? false,
      });
    },
    diagnostic: (event, data) => logFourShogiDiagnostic(env, event, data),
  };
}
