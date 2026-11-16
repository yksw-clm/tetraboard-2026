import type {
  GameId,
  Room,
  RoomSocketClientMessage,
  RoomSocketMessage,
  RoomTimeControl,
} from "@tetraboard/protocol";
import type { RoomJobs } from "../../adapters/room/jobs";
import type { AiServiceBindings } from "../../rooms/aiService";
import type { CpuCapacityGame } from "../../rooms/cpuCapacity";
import type { ActionCommand, GameAdapter, SettingsCommand } from "../../rooms/gameAdapters/types";
import type { RoomAlarmEvents } from "../../rooms/roomAlarmEvents";
import type { TransactionUsageEvents } from "../../usageEvents/transactionEvents";

export type RoomSocketError = Extract<RoomSocketMessage, { type: "room.error" }>["error"];
export type SocketCommand<T extends RoomSocketClientMessage["type"]> = Extract<
  RoomSocketClientMessage,
  { type: T }
>;
export type RoomUpdateResult =
  | { status: "updated"; room: Room }
  | { status: "unchanged" | RoomSocketError };
export type GameActionResult<T extends string> =
  | { status: T; room: Room | null }
  | { status: RoomSocketError };

export type RoomCpuCapacity = {
  roomId: string;
  sequence: number;
  game: CpuCapacityGame;
  instanceId: string;
  // nullは準備済み・進行中の予約です。時刻がある予約は解放を再試行します。
  releaseAtMs: number | null;
};

export type RoomRuntime = {
  alarms: Pick<RoomAlarmEvents, "sync" | "afterFlush" | "mark">;
  jobs: RoomJobs;
  usageEvents: TransactionUsageEvents;
  cpuCapacity: Env["CPU_CAPACITY"];
  accountBindings: Env;
  db: D1Database;
  aiService: () => AiServiceBindings & { AI_WARMUP_ENABLED?: string };
  closeRoom: () => void;
  ctx: DurableObjectState;
  chat: { dirty: boolean };
  reconcileDeadlines: (applyCpu?: boolean) => Promise<void>;
  gameAdapter: <G extends GameId>(room: { settings: { game: G } }) => GameAdapter<G>;
  setReady: (hash: string, ready: boolean) => RoomUpdateResult;
  applySettings: (hash: string, command: SocketCommand<"room.settings.apply">) => RoomUpdateResult;
  updateGameSettings: (hash: string, command: SettingsCommand) => RoomUpdateResult;
  setTimeControl: (hash: string, timeControl: RoomTimeControl) => RoomUpdateResult;
  startGame: (
    hash: string,
  ) => Promise<{ status: "started"; room: Room } | { status: RoomSocketError }>;
  setShogiDrawProposal: (
    hash: string,
    command: SocketCommand<"room.game.draw.set">,
  ) => GameActionResult<"updated" | "unchanged">;
  declareShogi: (
    hash: string,
    command: SocketCommand<"room.game.declare">,
  ) => GameActionResult<"updated">;
  resign: (hash: string) => GameActionResult<"resigned">;
  play: (hash: string, command: ActionCommand) => GameActionResult<"placed">;
};
