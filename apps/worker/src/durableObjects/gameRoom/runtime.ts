import type {
  GameId,
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

export type RoomRuntime = {
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
