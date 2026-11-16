import type { GameId, Room, RoomFor } from "@tetraboard/protocol";
import type { CpuCapacityGame } from "../cpuCapacity";
import type { PlayingFor, ProgressFor } from "../gameProgress";

export type CpuPlayerFor<G extends GameId> = Extract<
  RoomFor<G>["players"][number],
  { kind: "cpu" }
>;

export interface ExternalCpuResponse {
  apply(room: Room | null, now: number): void;
  afterTransaction?(): void;
}

export interface ExternalCpuRequest {
  request(): Promise<ExternalCpuResponse>;
}

export interface CpuStepContext<G extends GameId> {
  now: number;
  hasCapacity(room: RoomFor<G>): boolean;
  applyProgress(result: ProgressFor<G>): RoomFor<G> | null;
}

export interface CpuStepResult<G extends GameId> {
  room: RoomFor<G> | null;
  external?: ExternalCpuRequest | null;
  afterTransaction?(): void;
}

export interface GameCpuAdapter<G extends GameId> {
  currentCpu(room: RoomFor<G>): CpuPlayerFor<G> | null;
  usesIdleDeadline(room: RoomFor<G>): boolean;
  keepsPlayingWithoutHumans(room: RoomFor<G>): boolean;
  waitUntilMatchFlush: boolean;
  capacity: {
    game(room: RoomFor<G>): CpuCapacityGame | null;
    seats(room: RoomFor<G>): number;
    recoverPlaying(room: PlayingFor<G>): boolean;
  };
  timeout(room: PlayingFor<G>, at: number): ProgressFor<G>;
  disconnect(room: PlayingFor<G>, playerId: string, at: number): ProgressFor<G>;
  alarmAt(room: PlayingFor<G>): number;
  step(room: PlayingFor<G>, context: CpuStepContext<G>): CpuStepResult<G>;
}
