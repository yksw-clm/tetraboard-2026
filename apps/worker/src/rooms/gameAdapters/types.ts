import type { RoomGamePort } from "@tetraboard/context-room";
import type {
  FourShogiAnalysisReplayPage,
  FourShogiEliminatedHands,
  FourShogiReplayEvent,
  FourShogiReplayPage,
  GameId,
  Room,
  RoomFor,
  ShogiReplayEvent,
  ShogiReplayPage,
  SystemChatMessage,
} from "@tetraboard/protocol";
import type { QueueRatingSource } from "../../matchmaking/ratedMatchmaking";
import type { AiServiceBindings } from "../aiService";
import type { PlayingFor, ProgressDependencies, ProgressError, WaitingFor } from "../gameProgress";
import type { TournamentRoomContext } from "../tournamentRoom";
import type { GameCpuAdapter } from "./cpuTypes";

export type {
  ActionCommand,
  DeclareCommand,
  DrawCommand,
  SettingsCommand,
  SettingsResult,
} from "@tetraboard/context-room";
export type StartContext =
  | { kind: "normal" }
  | { kind: "tournament"; tournament: TournamentRoomContext }
  | { kind: "matchmaking"; rating: QueueRatingSource | undefined };
export type ReplayResult =
  | { status: "found"; page: FourShogiReplayPage | ShogiReplayPage }
  | { status: "not_found" };
export type AnalysisReplayResult =
  | { status: "found"; page: FourShogiAnalysisReplayPage }
  | { status: "not_found" | "stale_position" };
export interface AdapterDependencies extends ProgressDependencies {
  aiService(): AiServiceBindings;
  appendSystem: (event: SystemChatMessage["event"], text: string) => void;
  recordDeparture: (player: Room["players"][number]) => void;
  logFourShogiDiagnostic: (
    event: string,
    fields: Record<string, string | number | boolean>,
  ) => void;
}

export interface GameAdapter<G extends GameId> extends Omit<
  RoomGamePort<G>,
  "start" | "keepsPlayingWithoutHumans" | "capacity" | "prepareSettings"
> {
  cpu: GameCpuAdapter<G>;
  start(
    room: WaitingFor<G>,
    context: StartContext,
  ): { room: PlayingFor<G>; roundId: string; at: number };
  migrateLegacy(room: RoomFor<G>, saved: object, readReplay: () => unknown): void;
  close(): void;
  waitingSeat: { side: null } | { color: null };
  allowsCompetitiveDraw: boolean;
  lastRoundId(room: RoomFor<G>): string | undefined;
  displayHands(
    room: RoomFor<G>,
    requested: boolean,
  ): { eliminatedHands?: FourShogiEliminatedHands | null };
  replay(room: RoomFor<G>, roundId: string, cursor: number): ReplayResult;
  analysisReplay(
    room: RoomFor<G>,
    roundId: string,
    revision: number,
    cursor: number,
  ): AnalysisReplayResult;
  replayEvents(roundId: string, cursor: number): (FourShogiReplayEvent | ShogiReplayEvent)[];
  keepsArchive(room: RoomFor<G>, roundId: string): boolean;
  releaseArchive(roundId: string, keep: boolean): void;
  matchmakingDiagnostic(
    rating: QueueRatingSource | undefined,
    matchId: string,
    event: string,
    atMs: number,
  ): void;
}

export type AdapterInstance<G extends GameId> = GameAdapter<G>;

export function rejected(error: ProgressError = "invalid_request"): {
  kind: "rejected";
  error: ProgressError;
} {
  return { kind: "rejected", error };
}
