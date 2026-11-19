import { isRatedMatchmakingGame, matchmakingRules } from "@tetraboard/protocol";
import { readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { closeRoom } from "../../adapters/room/useCases";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import type { MatchmakingRoomReservation } from "@tetraboard/context-matchmaking";
import { requestRatedAiWarmup, type RatedAiGame } from "../../adapters/room/ai/ratedAiWarmup";
import { advanceMatchmakingStart } from "./start";

const aiWarmupAttemptMs = 8000;
const aiWarmupRetryMs = 2000;
const aiWarmupMaxAttempts = 2;

export function startMatchmakingAiWarmup(
  runtime: RoomRuntime,
  reservation: MatchmakingRoomReservation,
) {
  const warmup = reservation.aiWarmup;
  const game = reservation.game ?? readRoom(runtime)?.settings.game;
  if (warmup?.state !== "pending" || !game || !isRatedMatchmakingGame(game)) return;
  const key = `matchmaking:${reservation.matchId}`;
  const now = Date.now();
  const latest = reservation.expiresAtMs - matchmakingRules.countdownMs;
  if (now >= latest || (warmup.attempts >= aiWarmupMaxAttempts && now >= warmup.nextAtMs)) {
    withIndexTransaction(runtime, () => {
      runtime.ctx.storage.kv.put(key, { ...reservation, aiWarmup: { state: "failed" } });
      closeRoom(runtime);
    });
    console.info({
      event: "rated_ai_warmup_unavailable",
      game,
      matchId: reservation.matchId,
      atMs: now,
    });
    return;
  }
  if (now < warmup.nextAtMs) return;
  const attempt = warmup.attempts + 1;
  const deadline = Math.min(now + aiWarmupAttemptMs, latest);
  // 保存済みの期限で重複送信を防ぎ、処理が中断してもAlarmで再開します。
  runtime.ctx.storage.kv.put(key, {
    ...reservation,
    aiWarmup: { state: "pending", attempts: attempt, nextAtMs: deadline + aiWarmupRetryMs },
  } satisfies MatchmakingRoomReservation);
  console.info({
    event: "rated_ai_warmup_started",
    game,
    matchId: reservation.matchId,
    attempt,
    atMs: now,
  });
  runtime.alarms.mark();
  runtime.ctx.waitUntil(
    runtime.alarms.trackWork(() =>
      finishMatchmakingAiWarmup(runtime, key, game, attempt, deadline),
    ),
  );
}

async function finishMatchmakingAiWarmup(
  runtime: RoomRuntime,
  key: string,
  game: RatedAiGame,
  attempt: number,
  deadline: number,
) {
  await runtime.alarms.sync();
  const failure = await requestRatedAiWarmup(runtime.aiService(), game, deadline);
  const saved = runtime.ctx.storage.kv.get<MatchmakingRoomReservation>(key);
  const room = readRoom(runtime);
  if (
    !saved ||
    saved.phase !== "waiting" ||
    saved.aiWarmup?.state !== "pending" ||
    saved.aiWarmup.attempts !== attempt ||
    room?.instanceId !== saved.instanceId
  )
    return;
  const now = Date.now();
  const reason = now >= deadline ? "timeout" : failure;
  runtime.ctx.storage.kv.put(key, {
    ...saved,
    aiWarmup: reason
      ? {
          state: "pending",
          attempts: attempt,
          nextAtMs: attempt < aiWarmupMaxAttempts ? now + aiWarmupRetryMs : now,
        }
      : { state: "ready" },
  } satisfies MatchmakingRoomReservation);
  console.info({
    event: reason ? "rated_ai_warmup_failed" : "rated_ai_warmup_ready",
    game,
    matchId: saved.matchId,
    attempt,
    atMs: now,
    ...(reason ? { reason } : {}),
  });
  runtime.alarms.mark();
  await advanceMatchmakingStart(runtime);
  await runtime.alarms.sync();
}
