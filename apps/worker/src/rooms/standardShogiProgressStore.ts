import { savedProfileRatings } from "../adapters/rating/profileRatings";
import { shogiRoomSchema, isShogiRoom, type ShogiLastRound } from "@tetraboard/protocol";
import {
  sides,
  getActionAvailability,
  getCheckState,
  type Side,
  type ShogiState,
} from "@tetraboard/shogi";
import { shogiDefinition as definition } from "@tetraboard/shogi/definition";
import { StandardShogiStore } from "./standardShogiStore";
import {
  standardShogiMatchStartKey as shogiMatchStartKey,
  pendingStandardShogiMatchPrefix as pendingShogiMatchPrefix,
  type StandardShogiMatchRecord,
  type PendingStandardShogiMatch,
} from "../adapters/record/shogiMatchStore";
import { initializeClock } from "@tetraboard/context-room";
import { ratedTimeControls } from "../adapters/rating/ratedTimeControls";
import {
  roomStorageKey,
  playerLabel,
  playerAppearance,
  nextPublicUpdateAt,
  shuffledAssignments,
} from "./progressHelpers";
import type {
  ProgressDependencies,
  PlayingFor,
  WaitingFor,
  FinishedProgress,
} from "./gameProgress";
import type { ShogiRatingSource } from "../adapters/rating/shogiRating";
import { shogiCpuJobKey, externalShogiCpuJobKey } from "./standardShogiCpu";
type Playing = PlayingFor<"shogi">;
export type ActiveShogiMatch = {
  start: Omit<StandardShogiMatchRecord, "endedAtMs" | "game" | "replay">;
};

export function startShogiRound(
  storage: DurableObjectStorage,
  store: StandardShogiStore,
  accountId: ProgressDependencies["accountId"],
  room: WaitingFor<"shogi">,
  rating?: ShogiRatingSource,
): {
  room: Playing;
  roundId: string;
  at: number;
} {
  if (rating) {
    const clock = room.settings.timeControl;
    const cpuCount = room.players.filter((player) => player.kind === "cpu").length;
    if (
      !ratedTimeControls("shogi").some(
        (time) => clock.mainTimeMs === time.mainTimeMs && clock.byoyomiMs === time.byoyomiMs,
      ) ||
      cpuCount !== Number(rating.kind === "cpu")
    )
      throw new Error("Invalid rated Shogi room");
  }
  const assignments = shuffledAssignments(sides);
  const players = room.players.map((player, index) =>
    player.kind === "cpu"
      ? { ...player, side: assignments[index], ready: true as const }
      : { ...player, side: assignments[index], ready: false },
  );
  const seatId = (side: Side): string => {
    const player = players.find((p) => p.side === side);
    if (!player) throw new Error("Missing assigned Shogi seat");
    return player.id;
  };
  const initial = {
    players: {
      south: seatId("south"),
      north: seatId("north"),
    },
  };
  const state = definition.rules.createInitialState(initial);
  const roundId = room.matchmaking?.id ?? crypto.randomUUID();
  const at = Date.now();
  store.startReplay(roundId, initial);
  storage.kv.delete(shogiCpuJobKey);
  storage.kv.delete(externalShogiCpuJobKey);
  const started = createStartedRoom(room, players, state, roundId, at, store);
  storage.kv.put(roomStorageKey, started);
  saveMatchStart(storage, started, accountId, at, rating);
  return { room: started, roundId, at };
}

function createStartedRoom(
  room: WaitingFor<"shogi">,
  players: Playing["players"],
  state: ShogiState,
  roundId: string,
  at: number,
  store: StandardShogiStore,
): Playing {
  const started = shogiRoomSchema.parse({
    ...room,
    status: "playing",
    lastRound: null,
    players,
    roundId,
    positionRevision: 0,
    game: store.saveState(roundId, state),
    ...getActionAvailability(state),
    checkState: getCheckState(state),
    eliminations: [],
    clock: initializeClock(
      {
        south: room.settings.timeControl.mainTimeMs,
        north: room.settings.timeControl.mainTimeMs,
      },
      at,
      room.settings.timeControl,
    ),
    publicUpdatedAtMs: nextPublicUpdateAt(room),
    lastActivityAtMs: at,
  });
  if (!isShogiRoom(started) || started.status !== "playing")
    throw new Error("Shogi game did not start");
  return started;
}

function saveMatchStart(
  storage: DurableObjectStorage,
  started: Playing,
  accountId: ProgressDependencies["accountId"],
  at: number,
  rating?: ShogiRatingSource,
) {
  storage.kv.put(shogiMatchStartKey, {
    start: {
      ...savedProfileRatings(storage, started.roundId),
      id: started.roundId,
      roomId: started.id,
      instanceId: started.instanceId,
      startedAtMs: at,
      settings: started.settings,
      ...(rating ? { rating } : {}),
      participants: started.players.map((player, seat) => ({
        id: player.id,
        name: playerLabel(player),
        side: player.side,
        seat,
        ...(player.kind === "cpu"
          ? { kind: "cpu" as const, level: player.level }
          : {
              kind: "human" as const,
              accountId: accountId(player.id),
            }),
      })),
    },
  } satisfies ActiveShogiMatch);
}

export function finalizeShogiRound(
  storage: DurableObjectStorage,
  store: StandardShogiStore,
  result: FinishedProgress<"shogi">,
): ShogiLastRound {
  const { room, game: core, at } = result;
  const active = storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey);
  if (active?.start.id === room.roundId) {
    store.protectArchive(room.roundId);
    storage.kv.put(pendingShogiMatchPrefix + room.roundId, {
      record: {
        ...active.start,
        endedAtMs: at,
        game: core,
        replay: {
          rulesVersion: 1,
          initial: store.replayInfo(room.roundId),
          eventCount: store.eventCount(room.roundId),
        },
      },
      progress: { phase: "upload", cursor: 0 },
      retryAtMs: Date.now(),
    } satisfies PendingStandardShogiMatch);
  }
  storage.kv.delete(shogiMatchStartKey);
  const lastRound: ShogiLastRound = {
    roundId: room.roundId,
    game: core,
    players: room.players.map((player) => ({
      id: player.id,
      name: playerLabel(player),
      side: player.side,
      appearance: playerAppearance(player),
    })),
    eventCount: store.eventCount(room.roundId),
  };
  return lastRound;
}
