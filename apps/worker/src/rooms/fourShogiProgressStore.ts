import { savedProfileRatings } from "../accounts/profileRatings";
import { fourReversiRatingMethod } from "@tetraboard/context-rating";
import type { FourShogiRatingSource } from "../matchmaking/fourShogiSelection";
import {
  fourShogiRoomSchema,
  isFourShogiRoom,
  type FourShogiRoom,
  type FourShogiLastRound,
} from "@tetraboard/protocol";
import {
  getActionAvailability,
  getCheckState,
  sides,
  type Side,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import { fourShogiDefinition as definition } from "@tetraboard/four-shogi/definition";
import type { ShogiStore } from "./shogiStore";
import type { TournamentRoomContext } from "./tournamentRoom";
import {
  emptyKnockouts,
  pendingShogiMatchPrefix,
  shogiMatchStartKey,
  type ActiveShogiMatch,
  type PendingShogiMatch,
} from "./shogiMatchStore";
import { createShogiClock } from "./shogiClock";
import { emptyFormationUsage, isFormationMatchEligible } from "./shogiFormationUsage";
import {
  roomStorageKey,
  shogiCpuJobKey,
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
  RematchFor,
} from "./gameProgress";
import { fourShogiAiJobKey } from "./fourShogiCpu";
import { shogiEliminatedHandsKey } from "./fourShogiProgressRecords";
type Playing = PlayingFor<"four-shogi">;
export function startFourShogiRound(
  storage: DurableObjectStorage,
  store: ShogiStore,
  accountId: ProgressDependencies["accountId"],
  room: Extract<FourShogiRoom, { status: "waiting" }>,
  tournament?: TournamentRoomContext,
  rating?: FourShogiRatingSource,
): {
  room: Playing;
  roundId: string;
  at: number;
} {
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
    mode: room.settings.mode,
    threePlayerAttackProhibited: room.settings.threePlayerAttackProhibited,
    players: {
      south: seatId("south"),
      west: seatId("west"),
      north: seatId("north"),
      east: seatId("east"),
    },
  };
  const state = definition.rules.createInitialState(initial);
  const roundId = (rating && room.matchmaking?.id) || tournament?.matchId || crypto.randomUUID();
  const at = Date.now();
  store.startReplay(roundId, initial);
  storage.kv.put(shogiEliminatedHandsKey, { roundId, hands: {} });
  storage.kv.delete(shogiCpuJobKey);
  storage.kv.delete(fourShogiAiJobKey);
  const started = createStartedRoom(storage, store, room, players, state, roundId, at);
  saveMatchStart(storage, accountId, room, started, at, tournament, rating);
  return { room: started, roundId, at };
}
function createStartedRoom(
  storage: DurableObjectStorage,
  store: ShogiStore,
  room: WaitingFor<"four-shogi">,
  players: Playing["players"],
  state: FourShogiState,
  roundId: string,
  at: number,
): Playing {
  const { tournamentStartsAtMs: _tournamentStartsAtMs, ...waiting } = room;
  const started = fourShogiRoomSchema.parse({
    ...waiting,
    status: "playing",
    lastRound: null,
    players,
    roundId,
    positionRevision: 0,
    game: store.saveState(roundId, state),
    ...getActionAvailability(state),
    checkState: getCheckState(state),
    eliminations: [],
    clock: createShogiClock(at, room.settings.timeControl),
    publicUpdatedAtMs: nextPublicUpdateAt(room),
    lastActivityAtMs: at,
  });
  if (!isFourShogiRoom(started) || started.status !== "playing")
    throw new Error("Shogi game did not start");
  storage.kv.put(roomStorageKey, started);
  return started;
}
function ratingSnapshot(
  started: Playing,
  rating: FourShogiRatingSource,
): NonNullable<ActiveShogiMatch["start"]["fourShogiRating"]> {
  return {
    method: fourReversiRatingMethod,
    calibrationVersion: rating.calibrationVersion,
    cpu: Object.fromEntries(
      started.players.flatMap((player) =>
        player.kind === "cpu" && rating.cpu ? [[player.side, rating.cpu]] : [],
      ),
    ),
  };
}
function saveMatchStart(
  storage: DurableObjectStorage,
  accountId: ProgressDependencies["accountId"],
  room: WaitingFor<"four-shogi">,
  started: Playing,
  at: number,
  tournament?: TournamentRoomContext,
  rating?: FourShogiRatingSource,
) {
  const roundId = started.roundId;
  storage.kv.put(shogiMatchStartKey, {
    ...(tournament ? { tournament } : {}),
    start: {
      ...savedProfileRatings(storage, roundId),
      id: roundId,
      roomId: room.id,
      instanceId: room.instanceId,
      startedAtMs: at,
      settings: room.settings,
      ...(rating ? { fourShogiRating: ratingSnapshot(started, rating) } : {}),
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
    knockouts: emptyKnockouts(),
    ...(isFormationMatchEligible({
      settings: room.settings,
      participants: started.players,
      rated: rating !== undefined,
    })
      ? { formationUsage: emptyFormationUsage() }
      : {}),
  } satisfies ActiveShogiMatch);
}
export function finalizeFourShogiRound(
  storage: DurableObjectStorage,
  store: ShogiStore,
  result: FinishedProgress<"four-shogi">,
): FourShogiLastRound {
  const { room, game: core, at } = result;
  const active = storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey);
  if (active?.start.id === room.roundId) {
    store.protectArchive(room.roundId);
    storage.kv.put(pendingShogiMatchPrefix + room.roundId, {
      ...(active.tournament ? { tournament: active.tournament } : {}),
      record: {
        ...active.start,
        endedAtMs: at,
        game: core,
        knockouts: active.knockouts,
        replay: {
          rulesVersion: 1,
          initial: store.replayInfo(room.roundId),
          eventCount: store.eventCount(room.roundId),
        },
      },
      progress: { phase: "upload", cursor: 0 },
      ...(active.formationUsage ? { formationUsage: active.formationUsage } : {}),
      retryAtMs: Date.now(),
    } satisfies PendingShogiMatch);
  }
  storage.kv.delete(shogiMatchStartKey);
  const lastRound: FourShogiLastRound = {
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

export function waitingFourShogiRoom(
  data: RematchFor<"four-shogi">,
  players: FourShogiRoom["players"],
): WaitingFor<"four-shogi"> {
  const room = fourShogiRoomSchema.parse({
    ...data.room,
    status: "waiting",
    eliminations: [],
    publicUpdatedAtMs: nextPublicUpdateAt(data.room),
    lastActivityAtMs: data.at,
    players: players.map((p) => ({ ...p, side: null })),
    game: null,
    clock: null,
    lastRound: data.lastRound,
    roundId: null,
    positionRevision: 0,
    legalActions: [],
    threePlayerAttackForbiddenActions: [],
    checkState: { south: false, west: false, north: false, east: false },
  });
  if (room.status !== "waiting") throw new Error("Expected waiting room");
  return room;
}
