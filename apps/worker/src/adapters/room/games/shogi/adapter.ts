import { shogiCpu } from "./cpuAdapter";
import { shogiRoomSchema } from "@tetraboard/protocol";
import { gameProgress } from "../gameProgress";
import type { ShogiProgress } from "./progress";
import { nextPublicUpdateAt } from "../progressHelpers";
import { adapterDefaults, invalidMatchmakingRoom } from "../base";
import {
  rejected,
  type AdapterDependencies,
  type AdapterInstance,
  type GameAdapter,
  type StartContext,
} from "../types";

function rating(context: StartContext) {
  if (context.kind !== "matchmaking") return undefined;
  return context.rating?.kind === "human" || context.rating?.kind === "cpu"
    ? context.rating
    : invalidMatchmakingRoom();
}

function replayOperations(
  progress: ShogiProgress,
): Pick<
  GameAdapter<"shogi">,
  "close" | "lastRoundId" | "replay" | "replayEvents" | "keepsArchive" | "releaseArchive"
> {
  return {
    close: () => progress.store().clear(),
    lastRoundId: (room) => room.lastRound?.roundId,
    replay: (room, roundId, cursor) => {
      if (room.status !== "waiting" || room.lastRound?.roundId !== roundId)
        return { status: "not_found" };
      const page = progress.store().getPage(room.instanceId, roundId, cursor);
      return page ? { status: "found", page } : { status: "not_found" };
    },
    replayEvents: (roundId, cursor) => progress.store().replayEvents(roundId, cursor),
    keepsArchive: (room, roundId) =>
      room.status === "waiting" && room.lastRound?.roundId === roundId,
    releaseArchive: (roundId, keep) => progress.store().releaseArchive(roundId, keep),
  };
}

function leaveOperations(
  progress: ShogiProgress,
): Pick<GameAdapter<"shogi">, "prepareLeave" | "afterLeave"> {
  return {
    prepareLeave: (room, playerId) => (at) => progress.eliminate(room, playerId, "left", at),
    afterLeave: (room, original, at, hostLeaving) =>
      shogiRoomSchema.parse({
        ...room,
        publicUpdatedAtMs:
          hostLeaving && room.status === "playing"
            ? nextPublicUpdateAt(original)
            : room.publicUpdatedAtMs,
        lastActivityAtMs: at,
      }),
  };
}

export function createShogiAdapter(dependencies: AdapterDependencies) {
  const progress = gameProgress.shogi.create(dependencies);
  return {
    ...adapterDefaults("shogi", progress, dependencies, {
      waitingSeat: { side: null },
      supportsMode: false,
    }),
    ...replayOperations(progress),
    ...leaveOperations(progress),
    cpu: shogiCpu(progress, dependencies),
    start: (room, context) => progress.start(room, rating(context)),
    play: (room, hash, command) => {
      if (command.action.type !== "movePiece" && command.action.type !== "dropPiece")
        return rejected("invalid_move");
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
    draw: (room, hash, command) => progress.draw(room, hash, command),
    afterDraw: (room) =>
      room.status === "playing"
        ? progress.cpuDraw(room, Date.now())
        : { kind: "unchanged", gameId: "shogi", room },
    declare: (room, hash, command) => progress.declare(room, hash, command),
    allowsCompetitiveDraw: true,
  } satisfies AdapterInstance<"shogi">;
}
