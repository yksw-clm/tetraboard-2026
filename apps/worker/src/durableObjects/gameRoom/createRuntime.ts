import type { GameId } from "@tetraboard/protocol";
import { nextAlarmAt } from "../../adapters/room/alarm";
import { TransactionRoomEffects, executeRoomEffect } from "../../adapters/room/effects";
import { createRoomJobs } from "../../adapters/room/jobs";
import { readMembership } from "../../adapters/room/state";
import { appendRoomSystem, recordDeparture } from "../../adapters/room/useCases";
import { storedAccount } from "../../flows/accountSeats/seats";
import { logFourShogiDiagnostic } from "../../fourShogiDiagnostics";
import { createGameAdapters } from "../../adapters/room/games";
import type { GameAdapter } from "../../adapters/room/games/types";
import { unreachable } from "../../adapters/room/games/gameProgress";
import { RoomAlarmEvents } from "../../adapters/room/roomAlarmEvents";
import { TransactionUsageEvents } from "../../usageEvents/transactionEvents";
import { reconcileDeadlines } from "./deadlines";
import type { RoomRuntime } from "./runtime";

function selectAdapter<G extends GameId>(
  adapters: ReturnType<typeof createGameAdapters>,
  room: { settings: { game: G } },
): GameAdapter<G> {
  const game = room.settings.game;
  const typed: { [K in GameId]: GameAdapter<K> } = adapters;
  switch (game) {
    case "four-gomoku":
    case "gomoku":
    case "four-reversi":
    case "reversi":
    case "four-shogi":
    case "shogi":
      return typed[game];
    default:
      return unreachable(game);
  }
}

function runtimeAdapters(runtime: RoomRuntime) {
  return createGameAdapters({
    storage: runtime.ctx.storage,
    membership: (hash) => readMembership(runtime, hash),
    accountId: (id) => storedAccount(runtime, id)?.accountId ?? null,
    aiService: runtime.aiService,
    appendSystem: (event, text) => appendRoomSystem(runtime, event, text),
    recordDeparture: (player) => recordDeparture(runtime, player),
    logFourShogiDiagnostic: (event, fields) =>
      logFourShogiDiagnostic(runtime.accountBindings, event, fields),
  });
}

export function createRoomAlarms(
  owner: object,
  ctx: DurableObjectState,
  runtime: () => RoomRuntime,
) {
  return new RoomAlarmEvents(
    owner,
    ctx.storage,
    (room) => nextAlarmAt(runtime(), room),
    (task) => ctx.waitUntil(task),
  );
}

export function createRoomRuntime(
  ctx: DurableObjectState,
  getEnv: () => Env,
  alarms: RoomAlarmEvents,
): RoomRuntime {
  const runtime: RoomRuntime = {
    ctx,
    alarms,
    get cpuCapacity() {
      return getEnv().CPU_CAPACITY;
    },
    get accountBindings() {
      return getEnv();
    },
    get db() {
      return getEnv().APP_DB;
    },
    aiService: () => getEnv(),
    effects: new TransactionRoomEffects((effect) => executeRoomEffect(runtime, effect)),
    chat: { dirty: false },
    usageEvents: new TransactionUsageEvents(() => getEnv().USAGE_EVENTS),
    get jobs() {
      return jobs;
    },
    reconcileDeadlines: (applyCpu) => reconcileDeadlines(runtime, applyCpu),
    gameAdapter: (room) => selectAdapter(adapters, room),
  };
  const adapters = runtimeAdapters(runtime);
  const jobs = createRoomJobs(runtime);
  return runtime;
}
