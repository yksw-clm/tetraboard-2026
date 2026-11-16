import { fourShogiCpu } from "./fourShogiCpu";
import { fourShogiActionSchema, fourShogiRoomSchema, isFourShogiRoom } from "@tetraboard/protocol";
import { gameProgress } from "../gameProgress";
import type { FourShogiProgress } from "../fourShogiProgress";
import { nextPublicUpdateAt } from "../progressHelpers";
import { adapterDefaults, invalidMatchmakingRoom } from "./base";
import {
  rejected,
  type AdapterDependencies,
  type AdapterInstance,
  type GameAdapter,
} from "./types";
import type { SettingsPolicy } from "./settings";

function settingsPolicy(
  progress: FourShogiProgress,
  dependencies: AdapterDependencies,
): SettingsPolicy {
  return {
    waitingSeat: { side: null },
    supportsMode: true,
    special: (room, hash, command) => {
      if (!isFourShogiRoom(room) || command.type !== "room.three-player-attack.set")
        return { status: "invalid_request" };
      if (room.status !== "waiting") return { status: "already_started" };
      if (dependencies.membership(hash)?.role !== "host") return { status: "forbidden" };
      if (room.settings.threePlayerAttackProhibited === command.prohibited)
        return { status: "unchanged" };
      return { status: "updated", room: progress.settings(room, command.prohibited) };
    },
  };
}

function replayOperations(
  progress: FourShogiProgress,
): Pick<
  GameAdapter<"four-shogi">,
  | "close"
  | "lastRoundId"
  | "displayHands"
  | "replay"
  | "analysisReplay"
  | "replayEvents"
  | "keepsArchive"
  | "releaseArchive"
> {
  return {
    close: () => progress.store().clear(),
    lastRoundId: (room) => room.lastRound?.roundId,
    displayHands: (room, requested) => progress.displayHands(room, requested),
    replay: (room, roundId, cursor) => {
      if (room.status !== "waiting" || room.lastRound?.roundId !== roundId)
        return { status: "not_found" };
      const page = progress.store().getPage(room.instanceId, roundId, cursor);
      return page ? { status: "found", page } : { status: "not_found" };
    },
    analysisReplay: (room, roundId, revision, cursor) => {
      if (room.status !== "playing" || room.roundId !== roundId || room.game.mode !== "singles")
        return { status: "not_found" };
      if (room.positionRevision !== revision) return { status: "stale_position" };
      const page = progress.store().getPage(room.instanceId, roundId, cursor);
      return page
        ? {
            status: "found",
            page: {
              ...page,
              positionRevision: revision,
              initial: {
                mode: "singles",
                threePlayerAttackProhibited: page.initial.threePlayerAttackProhibited,
              },
            },
          }
        : { status: "not_found" };
    },
    replayEvents: (roundId, cursor) => progress.store().replayEvents(roundId, cursor),
    keepsArchive: (room, roundId) =>
      room.status === "waiting" && room.lastRound?.roundId === roundId,
    releaseArchive: (roundId, keep) => progress.store().releaseArchive(roundId, keep),
  };
}

function leaveOperations(
  progress: FourShogiProgress,
): Pick<GameAdapter<"four-shogi">, "prepareLeave" | "afterLeave"> {
  return {
    prepareLeave: (room, playerId) => (at) => progress.eliminate(room, playerId, "left", at),
    afterLeave: (room, original, at, hostLeaving) =>
      fourShogiRoomSchema.parse({
        ...room,
        publicUpdatedAtMs:
          hostLeaving && room.status === "playing"
            ? nextPublicUpdateAt(original)
            : room.publicUpdatedAtMs,
        lastActivityAtMs: at,
      }),
  };
}

export function createFourShogiAdapter(dependencies: AdapterDependencies) {
  const progress = gameProgress["four-shogi"].create(dependencies);
  return {
    ...adapterDefaults(
      "four-shogi",
      progress,
      dependencies,
      settingsPolicy(progress, dependencies),
    ),
    ...replayOperations(progress),
    ...leaveOperations(progress),
    cpu: fourShogiCpu(progress, dependencies),
    start: (room, context) => {
      if (context.kind === "matchmaking")
        return context.rating?.kind === "four-shogi"
          ? progress.start(room, undefined, context.rating)
          : invalidMatchmakingRoom();
      return progress.start(room, context.kind === "tournament" ? context.tournament : undefined);
    },
    play: (room, hash, command) => {
      const parsed = fourShogiActionSchema.safeParse(command.action);
      if (!parsed.success) return rejected("invalid_move");
      if (command.roundId === undefined || command.positionRevision === undefined)
        return rejected();
      return progress.play(room, hash, {
        ...command,
        action: parsed.data,
        roundId: command.roundId,
        positionRevision: command.positionRevision,
      });
    },
    resign: (room, hash) => progress.resign(room, hash),
    draw: (room, hash, command) => progress.draw(room, hash, command),
    normalize: (room, saved) => progress.normalize(room, saved),
    matchmakingDiagnostic: (rating, matchId, event, atMs) => {
      if (rating?.kind === "four-shogi")
        dependencies.logFourShogiDiagnostic(event, { matchId, atMs });
    },
  } satisfies AdapterInstance<"four-shogi">;
}
