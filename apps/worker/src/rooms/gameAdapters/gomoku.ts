import { isGomokuRoom, type Room } from "@tetraboard/protocol";
import { gameProgress } from "../gameProgress";
import { nextPublicUpdateAt } from "../progressHelpers";
import { adapterDefaults, invalidMatchmakingRoom } from "./base";
import {
  rejected,
  type AdapterDependencies,
  type AdapterInstance,
  type SettingsCommand,
  type SettingsResult,
} from "./types";

function settings(
  dependencies: AdapterDependencies,
  room: Room,
  hash: string,
  command: SettingsCommand,
): SettingsResult {
  if (!isGomokuRoom(room) || command.type !== "room.gomoku-forbidden.set")
    return { status: "invalid_request" };
  if (room.status !== "waiting") return { status: "already_started" };
  if (dependencies.membership(hash)?.role !== "host") return { status: "forbidden" };
  if (room.settings.forbiddenRules === command.enabled) return { status: "unchanged" };
  return {
    status: "updated",
    room: {
      ...room,
      settings: { ...room.settings, forbiddenRules: command.enabled },
      players: room.players.map((p) => (p.kind === "cpu" ? p : { ...p, ready: false })),
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: Date.now(),
    },
  };
}

export function createGomokuAdapter(dependencies: AdapterDependencies) {
  const progress = gameProgress.gomoku.create(dependencies);
  return {
    ...adapterDefaults("gomoku", progress, dependencies, {
      waitingSeat: { color: null },
      supportsMode: false,
      special: (room, hash, command) => settings(dependencies, room, hash, command),
    }),
    progress,
    start: (room, context) =>
      context.kind === "matchmaking" ? invalidMatchmakingRoom() : progress.start(room),
    play: (room, hash, command) => {
      if (command.action.type !== "placeGomokuStone") return rejected("invalid_move");
      if (command.roundId === undefined || command.positionRevision === undefined)
        return rejected();
      return progress.play(room, hash, {
        ...command,
        action: command.action,
        roundId: command.roundId,
        positionRevision: command.positionRevision,
      });
    },
    resign: (room, hash) => progress.resign(room, hash),
    prepareLeave: (room, playerId) => {
      const prepared = progress.prepareLeave(room, playerId);
      return (at, hostLeaving) => progress.leave(room, playerId, prepared, at, hostLeaving);
    },
  } satisfies AdapterInstance<"gomoku">;
}
