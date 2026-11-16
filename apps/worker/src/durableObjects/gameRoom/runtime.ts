import type { AiServiceBindings } from "../../rooms/aiService";
import type { CpuCapacityGame } from "../../rooms/cpuCapacity";
import type { IndexedRoomParticipant } from "../../rooms/roomIndex";
import type { AccountAdmission } from "../../accounts/roomAccounts";
import type {
  GameId,
  RoomPublicMetadata,
  MatchKind,
  Room,
  RoomMembership,
  RoomSocketClientMessage,
  RoomSocketMessage,
  RoomTimeControl,
} from "@tetraboard/protocol";
import type { ActionCommand, GameAdapter, SettingsCommand } from "../../rooms/gameAdapters/types";

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
  db: D1Database;
  aiService: () => AiServiceBindings & { AI_WARMUP_ENABLED?: string };
  markAlarm: () => void;
  reserveCpuCapacity: (
    room: Room,
  ) => Promise<RoomCpuCapacity | null | "cpu_capacity_full" | "internal_error">;
  flushCpuCapacity: () => Promise<void>;
  publicMetadata: (room: Room) => RoomPublicMetadata & {
    matchKind: MatchKind;
    matchSequence?: number;
    instanceId: string;
    hostPlayerId: string | null;
    participantPreviews: IndexedRoomParticipant[];
  };
  syncAlarm: () => Promise<void>;
  closeRoom: () => void;
  storedAccount: (playerId: string) => (AccountAdmission & { occupying: boolean }) | null;
  startAnalyticsMatch: (id: string, room: Room, at: number) => void;
  ctx: DurableObjectState;
  chat: { dirty: boolean };
  readRoom: () => Room | null;
  readMembership: (hash: string) => RoomMembership | null;
  publicMembership: (membership: RoomMembership) => RoomMembership;
  playerTokenHash: (playerId: string) => string | null;
  isHumanParticipant: (player: Room["players"][number]) => boolean;
  withIndexTransaction: <T>(action: () => T, previousRoom?: Room | null) => T;
  reconcileDeadlines: (applyCpu?: boolean) => Promise<void>;
  currentRoomMembership: (
    hash: string,
  ) => { status: "found"; membership: RoomMembership } | { status: "not_found" | "unauthorized" };
  advanceTournamentStart: () => Promise<void>;
  advanceMatchmakingStart: () => Promise<void>;
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
