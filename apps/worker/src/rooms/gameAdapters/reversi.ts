import { reversiCpu } from "./reversiCpu";
import { gameProgress } from "../gameProgress";
import { adapterDefaults, invalidMatchmakingRoom } from "./base";
import {
  rejected,
  type AdapterDependencies,
  type AdapterInstance,
  type StartContext,
} from "./types";

function rating(context: StartContext) {
  if (context.kind !== "matchmaking") return undefined;
  return context.rating?.kind === "reversi" ? context.rating.source : invalidMatchmakingRoom();
}

export function createReversiAdapter(dependencies: AdapterDependencies) {
  const progress = gameProgress.reversi.create(dependencies);
  return {
    ...adapterDefaults("reversi", progress, dependencies, {
      waitingSeat: { color: null },
      supportsMode: false,
    }),
    cpu: reversiCpu(progress, dependencies),
    start: (room, context) => progress.start(room, rating(context)),
    play: (room, hash, command) => {
      if (command.action.type !== "placeStone") return rejected("invalid_move");
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
    normalize: (room, saved) => progress.normalize(room, saved),
  } satisfies AdapterInstance<"reversi">;
}
