import type { GameId, RoomFor } from "@tetraboard/protocol";
import type { PlayingFor, ProgressFor } from "./gameProgress";

export interface RoomCpuStepContext<G extends GameId> {
  now: number;
  hasCapacity(room: RoomFor<G>): boolean;
  applyProgress(result: ProgressFor<G>): RoomFor<G> | null;
}
export interface RoomCpuStepResult<G extends GameId> {
  room: RoomFor<G> | null;
  // 外部要求の実行と診断は、transaction の確定後に殻が行います。
  external?: unknown;
  afterTransaction?(): void;
}
export interface RoomCpuPort<G extends GameId> {
  usesIdleDeadline(room: RoomFor<G>): boolean;
  timeout(room: PlayingFor<G>, at: number): ProgressFor<G>;
  disconnect(room: PlayingFor<G>, playerId: string, at: number): ProgressFor<G>;
  step(room: PlayingFor<G>, context: RoomCpuStepContext<G>): RoomCpuStepResult<G>;
}
