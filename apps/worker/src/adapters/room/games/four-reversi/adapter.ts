import { fourReversiCpu } from "./cpuAdapter";
import { gameProgress } from "../gameProgress";
import { adapterDefaults } from "../base";
import { rejected, type AdapterDependencies, type AdapterInstance } from "../types";

export function createFourReversiAdapter(dependencies: AdapterDependencies) {
  const progress = gameProgress["four-reversi"].create(dependencies);
  return {
    ...adapterDefaults("four-reversi", progress, dependencies, {
      waitingSeat: { color: null },
      supportsMode: true,
    }),
    snapshotOnMalformedAction: true,
    cpu: fourReversiCpu(progress, dependencies),
    start: (room, context) =>
      progress.start(
        room,
        context.kind === "tournament" ? context.tournament : undefined,
        context.kind === "matchmaking" && context.rating?.kind === "four-reversi"
          ? context.rating
          : undefined,
      ),
    play: (room, hash, command) => {
      if (command.action.type !== "placeStone") return rejected("invalid_move");
      if (command.roundId === undefined || command.positionRevision === undefined)
        return rejected();
      return progress.play(room, hash, {
        type: "room.game.action",
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
    migrateLegacy: (room, saved, readReplay) => progress.migrateLegacy(room, saved, readReplay),
    lastRoundId: (room) => room.lastRound?.replay?.id,
  } satisfies AdapterInstance<"four-reversi">;
}
