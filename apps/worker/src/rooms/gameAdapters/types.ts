import type {
  GameId,
  Room,
  RoomFor,
  RoomSocketClientMessage,
  FourShogiEliminatedHands,
  FourShogiReplayPage,
  FourShogiAnalysisReplayPage,
  ShogiReplayPage,
  FourShogiReplayEvent,
  ShogiReplayEvent,
  SystemChatMessage,
} from "@tetraboard/protocol";
import type {
  ProgressDependencies,
  ProgressFor,
  FinishedProgress,
  PlayingFor,
  WaitingFor,
  ProgressError,
} from "../gameProgress";
import type { TournamentRoomContext } from "../tournamentRoom";
import type { QueueRatingSource } from "../../matchmaking/ratedMatchmaking";
import type { AiServiceBindings } from "../aiService";
import type { GameCpuAdapter } from "./cpuTypes";

export type ActionCommand = Extract<RoomSocketClientMessage, { type: "room.game.action" }>;
export type DrawCommand = Extract<RoomSocketClientMessage, { type: "room.game.draw.set" }>;
export type DeclareCommand = Extract<RoomSocketClientMessage, { type: "room.game.declare" }>;
export type SettingsCommand = Extract<
  RoomSocketClientMessage,
  {
    type:
      | "room.mode.set"
      | "room.cpu.add"
      | "room.cpu.remove"
      | "room.cpu.level.set"
      | "room.gomoku-forbidden.set"
      | "room.three-player-attack.set";
  }
>;
export type SettingsResult =
  | { status: "updated"; room: Room }
  | {
      status:
        | "unchanged"
        | "already_started"
        | "forbidden"
        | "invalid_request"
        | "room_full"
        | "cpu_not_found";
    };
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

export interface GameAdapter<G extends GameId> {
  cpu: GameCpuAdapter<G>;
  start(
    room: WaitingFor<G>,
    context: StartContext,
  ): {
    room: PlayingFor<G>;
    roundId: string;
    at: number;
  };
  play(room: RoomFor<G>, hash: string, command: ActionCommand): ProgressFor<G>;
  draw(room: RoomFor<G>, hash: string, command: DrawCommand): ProgressFor<G>;
  afterDraw(room: RoomFor<G>): ProgressFor<G>;
  declare(room: RoomFor<G>, hash: string, command: DeclareCommand): ProgressFor<G>;
  settings(room: RoomFor<G>, hash: string, command: SettingsCommand): SettingsResult;
  resign(room: RoomFor<G>, hash: string): ProgressFor<G>;
  prepareLeave(
    room: PlayingFor<G>,
    playerId: string,
  ): (at: number, hostLeaving: boolean) => ProgressFor<G>;
  afterLeave(
    room: RoomFor<G>,
    original: PlayingFor<G>,
    at: number,
    hostLeaving: boolean,
  ): RoomFor<G>;
  finish(
    result: FinishedProgress<G>,
    retainPlayers: (players: RoomFor<G>["players"], at: number) => RoomFor<G>["players"] | null,
  ): RoomFor<G> | null;
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
