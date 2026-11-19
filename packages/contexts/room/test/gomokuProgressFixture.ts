import type { GameTransition } from "@tetraboard/game-contract";
import { gomokuDefinition, type GomokuTypes } from "@tetraboard/gomoku/definition";
import type { GameActionCommandFor, GomokuRoom, RoomMembership } from "@tetraboard/protocol";
import {
  advanceTurnClock,
  createGameProgress,
  initializeClock,
  type GameProgressStore,
  type PlayingFor,
} from "../src";
import type { ProgressCpuJob } from "../src/use-cases/gameProgressSpec";
import { human, now as initialTime } from "./memoryPorts";

type Playing = PlayingFor<"gomoku">;
type Transition = GameTransition<GomokuTypes["state"], GomokuTypes["event"]>;

function gomokuPlayingRoom(): Playing {
  const timeControl = { mainTimeMs: 60_000, byoyomiMs: 0 } as const;
  const settings = { game: "gomoku" as const, forbiddenRules: false, timeControl };
  const state = gomokuDefinition.rules.createInitialState(settings);
  if (state.status !== "playing") throw new Error("Expected playing state");
  return {
    id: "12345",
    instanceId: "instance",
    status: "playing",
    roundId: "round",
    positionRevision: 3,
    publicUpdatedAtMs: initialTime,
    lastActivityAtMs: initialTime,
    settings,
    players: [
      { ...human("host"), color: "black", reconnectDeadline: initialTime + 30_000 },
      { ...human("guest"), color: "white" },
    ],
    game: {
      ...state,
      board: state.board.map((row) => [...row]),
      eliminatedColors: [...state.eliminatedColors],
    },
    clock: initializeClock({ black: 60_000, white: 60_000 }, initialTime, timeControl),
    lastRound: null,
    eliminations: [],
  };
}

function memoryProgressStore() {
  const saved = {
    cpuJob: undefined as ProgressCpuJob<GomokuTypes> | undefined,
    transitions: [] as Transition[],
    calls: [] as string[],
  };
  const store: GameProgressStore<"gomoku", GomokuTypes> = {
    start: () => {
      throw new Error("Unexpected start");
    },
    recordTransition: (room, transition) => {
      saved.calls.push("recordTransition");
      const { state, event } = transition;
      saved.transitions.push({ state, event });
      if (event.type === "eliminate")
        room.eliminations.push({ color: event.color, reason: event.reason });
    },
    finalize: () => {
      throw new Error("Unexpected finalize");
    },
    readCpuJob: () => saved.cpuJob,
    writeCpuJob: (job) => {
      saved.cpuJob = job;
    },
    deleteCpuJob: () => {
      saved.calls.push("deleteCpuJob");
      saved.cpuJob = undefined;
    },
  };
  return { store, saved };
}

export function gomokuProgressFixture() {
  const room = gomokuPlayingRoom();
  const memberships = new Map<string, RoomMembership>([
    ["host-token", { playerId: "host", role: "host" }],
    ["guest-token", { playerId: "guest", role: "player" }],
  ]);
  const { store, saved } = memoryProgressStore();
  const time = { now: initialTime + 500 };
  const progress = createGameProgress<"gomoku", GomokuTypes>({
    gameId: "gomoku",
    definition: gomokuDefinition,
    parseRoom: (input) => structuredClone(input) as GomokuRoom,
    parseFinishedState: (state) => {
      if (state.status !== "finished") throw new Error("Expected finished state");
      return {
        ...state,
        board: state.board.map((row) => [...row]),
        eliminatedColors: [...state.eliminatedColors],
      };
    },
    seat: (player) => player.color,
    eliminatedSeats: (state) => state.eliminatedColors,
    waitingSeat: { color: null },
    unknownPlayerMessage: "Unknown Gomoku player",
    toAction: (command) => ({ type: "placeStone", position: command.action.position }),
    moveError: () => "invalid_move",
    advanceClock: (...args) => advanceTurnClock(...args),
    isClockExpired: (clock, at) => at >= clock.turnExpiresAt,
    membership: (hash) => memberships.get(hash) ?? null,
    accountId: () => null,
    now: () => time.now,
    random: () => 0,
    store,
  });
  return { room, progress, saved, time };
}

export function gomokuCommand(room: Playing): GameActionCommandFor<"gomoku"> {
  return {
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: { type: "placeGomokuStone", position: { x: 7, y: 7 } },
  };
}

export function useBlackCpu(room: Playing): void {
  room.players[0] = {
    id: "cpu",
    name: "CPU",
    kind: "cpu",
    color: "black",
    level: 1,
    ready: true,
    reconnectDeadline: null,
  };
}
