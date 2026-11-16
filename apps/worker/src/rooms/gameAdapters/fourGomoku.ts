import { cpuDefaults, savedCpuAlarm } from "./cpuBase";
import { fourGomokuCpuJobKey } from "../fourGomokuProgress";
import { gameProgress } from "../gameProgress";
import { adapterDefaults, invalidMatchmakingRoom } from "./base";
import { rejected, type AdapterDependencies, type AdapterInstance } from "./types";

export function createFourGomokuAdapter(dependencies: AdapterDependencies) {
  const progress = gameProgress["four-gomoku"].create(dependencies);
  return {
    ...adapterDefaults("four-gomoku", progress, dependencies, {
      waitingSeat: { color: null },
      supportsMode: true,
    }),
    cpu: {
      ...cpuDefaults<"four-gomoku">(progress, (room) =>
        room.players.find((player) => player.color === room.game.turn),
      ),
      alarmAt: (room) => savedCpuAlarm(dependencies.storage, fourGomokuCpuJobKey, room),
    },
    start: (room, context) =>
      context.kind === "matchmaking"
        ? invalidMatchmakingRoom()
        : progress.start(room, context.kind === "tournament" ? context.tournament : undefined),
    play: (room, hash, command) => {
      if (command.action.type !== "placeFourGomokuStone") return rejected("invalid_move");
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
    migrateLegacy: (room, _saved, readReplay) => progress.migrateLegacy(room, readReplay),
    lastRoundId: (room) => room.lastRound?.replay?.id,
  } satisfies AdapterInstance<"four-gomoku">;
}
