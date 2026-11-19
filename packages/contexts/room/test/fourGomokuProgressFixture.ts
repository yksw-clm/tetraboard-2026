import type { GameTransition } from "@tetraboard/game-contract";
import { fourGomokuDefinition, type FourGomokuTypes } from "@tetraboard/four-gomoku/definition";
import {
  fourGomokuFinishedStateSchema,
  fourGomokuRoomSchema,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import {
  advanceTurnClock,
  createGameProgress,
  initializeClock,
  type GameProgressStore,
  type PlayingFor,
  type WaitingFor,
} from "../src";
import { human, now as initialTime } from "./memoryPorts";

type Playing = PlayingFor<"four-gomoku">;
type StartArgs = [tournament?: { matchId: string }];
type Transition = GameTransition<FourGomokuTypes["state"], FourGomokuTypes["event"]>;

function playingRoom(mode: Playing["settings"]["mode"]): Playing {
  const timeControl = { mainTimeMs: 60_000, byoyomiMs: 0 } as const;
  const settings = { game: "four-gomoku" as const, mode, timeControl };
  const game = fourGomokuDefinition.rules.createInitialState(settings);
  const room = fourGomokuRoomSchema.parse({
    id: "12345",
    instanceId: "00000000-0000-4000-8000-000000000000",
    status: "playing",
    roundId: "00000000-0000-4000-8000-000000000001",
    positionRevision: 0,
    publicUpdatedAtMs: initialTime,
    lastActivityAtMs: initialTime,
    settings,
    players: fourGomokuDefinition.catalog.seats.map((color, index) => ({
      ...human(color),
      id: `00000000-0000-4000-8000-00000000001${index}`,
      color,
      reconnectDeadline: initialTime + 30_000,
    })),
    game,
    clock: initializeClock(
      { black: 60_000, white: 60_000, red: 60_000, blue: 60_000 },
      initialTime,
      timeControl,
    ),
    lastRound: null,
    eliminations: [],
  });
  if (room.status !== "playing") throw new Error("Expected playing room");
  return room;
}

export function fourGomokuProgressFixture(mode: Playing["settings"]["mode"] = "singles") {
  const room = playingRoom(mode);
  const at = initialTime + 500;
  const saved = {
    calls: [] as string[],
    transitions: [] as Transition[],
    start: undefined as { room: WaitingFor<"four-gomoku">; args: StartArgs } | undefined,
  };
  const store: GameProgressStore<"four-gomoku", FourGomokuTypes, StartArgs> = {
    start: (waiting, _accountId, ...args) => {
      saved.calls.push("start");
      saved.start = { room: waiting, args };
      const roundId = args[0]?.matchId ?? room.roundId;
      return { room: { ...room, roundId }, roundId, at };
    },
    recordTransition: (playing, transition) => {
      saved.calls.push("recordTransition");
      saved.transitions.push(transition);
      const { event } = transition;
      if (event.type === "eliminate")
        playing.eliminations.push({ color: event.color, reason: event.reason });
    },
    finalize: () => {
      throw new Error("Unexpected finalize");
    },
    cpuJobs: {
      read: () => undefined,
      write: () => {
        throw new Error("Unexpected CPU job");
      },
      delete: () => {
        saved.calls.push("deleteCpuJob");
      },
    },
  };
  const progress = createGameProgress<"four-gomoku", FourGomokuTypes, StartArgs>({
    gameId: "four-gomoku",
    definition: fourGomokuDefinition,
    parseRoom: (input) => fourGomokuRoomSchema.parse(input),
    parseFinishedState: (state) => fourGomokuFinishedStateSchema.parse(state),
    seat: (player) => player.color,
    inactiveSeats: (state) => [...state.eliminatedColors, ...state.completedColors],
    waitingSeat: { color: null },
    unknownPlayerMessage: "Unknown FourGomoku player",
    toAction: (command) => ({ type: "placeStone", position: command.action.position }),
    moveError: () => "invalid_move",
    prepareLeaveResult: ({ state }) => ({ ok: true, state }),
    advanceClock: (...args) => advanceTurnClock(...args),
    isClockExpired: (clock, time) => time >= clock.turnExpiresAt,
    membership: (token) => {
      const player = room.players.find((p) => p.color === token);
      return player ? { playerId: player.id, role: "player" } : null;
    },
    accountId: () => null,
    now: () => at,
    random: () => 0,
    store,
  });
  return { room, progress, saved, at };
}

export function fourGomokuCommand(room: Playing): GameActionCommandFor<"four-gomoku"> {
  return {
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: { type: "placeFourGomokuStone", position: { x: 7, y: 7 } },
  };
}

export function afterBlackCompletes(room: Playing): void {
  room.game = {
    ...room.game,
    turn: "white",
    completedColors: ["black"],
    standings: [{ color: "black", rank: 1, reason: "five" }],
  };
}
