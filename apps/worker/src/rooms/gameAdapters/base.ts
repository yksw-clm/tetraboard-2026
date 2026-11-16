import type { GameId, RoomFor } from "@tetraboard/protocol";
import type { FinishedProgress, LastRoundFor, RematchFor, WaitingFor } from "../gameProgress";
import { rejected, type GameAdapter, type AdapterDependencies } from "./types";
import { updateSettings, type SettingsPolicy } from "./settings";

type Finalization<G extends GameId> = {
  finalize(result: FinishedProgress<G>): LastRoundFor<G>;
  waiting(data: RematchFor<G>, players: RoomFor<G>["players"]): WaitingFor<G>;
};

export function adapterDefaults<G extends GameId>(
  gameId: G,
  progress: Finalization<G>,
  dependencies: AdapterDependencies,
  policy: SettingsPolicy,
): Pick<
  GameAdapter<G>,
  | "draw"
  | "declare"
  | "afterDraw"
  | "afterLeave"
  | "finish"
  | "settings"
  | "migrateLegacy"
  | "close"
  | "waitingSeat"
  | "allowsCompetitiveDraw"
  | "lastRoundId"
  | "displayHands"
  | "replay"
  | "analysisReplay"
  | "replayEvents"
  | "keepsArchive"
  | "releaseArchive"
  | "matchmakingDiagnostic"
> {
  return {
    draw: () => rejected(),
    declare: () => rejected(),
    afterDraw: (room) => ({ kind: "unchanged", gameId, room }),
    afterLeave: (room) => room,
    finish: (result, retainPlayers) => {
      const lastRound = progress.finalize(result);
      const players = retainPlayers(result.room.players, result.at);
      return players === null ? null : progress.waiting({ ...result, lastRound }, players);
    },
    settings: (room, hash, command) => updateSettings(dependencies, policy, room, hash, command),
    migrateLegacy: () => {},
    close: () => {},
    waitingSeat: policy.waitingSeat,
    allowsCompetitiveDraw: false,
    lastRoundId: () => undefined,
    displayHands: () => ({}),
    replay: () => ({ status: "not_found" }),
    analysisReplay: () => ({ status: "not_found" }),
    replayEvents: () => [],
    keepsArchive: () => false,
    releaseArchive: () => {},
    matchmakingDiagnostic: () => {},
  };
}

export function invalidMatchmakingRoom(): never {
  throw new Error("Invalid matchmaking room");
}
