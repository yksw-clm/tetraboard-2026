import type { GameId, Room, RoomFor, RoomSocketClientMessage } from "@tetraboard/protocol";
import type { FinishedProgress, PlayingFor, ProgressFor, WaitingFor } from "./gameProgress";
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
export interface RoomGamePort<G extends GameId> {
  keepsPlayingWithoutHumans(room: RoomFor<G>): boolean;
  capacity: number;
  prepareSettings(
    room: Room,
    command: Extract<RoomSocketClientMessage, { type: "room.settings.apply" }>,
    now: number,
  ): SettingsResult | { status: "room_changed" };
  start(room: WaitingFor<G>): {
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
  close(): void;
  waitingSeat: { side: null } | { color: null };
}
