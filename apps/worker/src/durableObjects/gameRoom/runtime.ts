import type {
  GameId,
  Room,
  RoomSocketClientMessage,
  RoomSocketMessage,
} from "@tetraboard/protocol";
import type { TransactionRoomEffects } from "../../adapters/room/effects";
import type { RoomJobs } from "../../adapters/room/jobs";
import type { AiServiceBindings } from "../../adapters/room/ai/aiService";
import type { CpuCapacityGame } from "../cpuCapacity";
import type { GameAdapter } from "../../rooms/gameAdapters/types";
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
  alarms: Pick<
    RoomAlarmEvents,
    "sync" | "afterFlush" | "mark" | "withRoom" | "hasActiveWork" | "trackWork"
  >;
  jobs: RoomJobs;
  usageEvents: TransactionUsageEvents;
  cpuCapacity: Env["CPU_CAPACITY"];
  accountBindings: Env;
  db: D1Database;
  aiService: () => AiServiceBindings & { AI_WARMUP_ENABLED?: string };
  effects: TransactionRoomEffects;
  ctx: DurableObjectState;
  chat: { dirty: boolean };
  reconcileDeadlines: (applyCpu?: boolean) => Promise<void>;
  gameAdapter: <G extends GameId>(room: { settings: { game: G } }) => GameAdapter<G>;
};
