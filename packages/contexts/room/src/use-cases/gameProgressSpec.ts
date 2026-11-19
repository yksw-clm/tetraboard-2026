import type { GameDefinition, GameTransition, GameTypes } from "@tetraboard/game-contract";
import type { GameActionCommandFor, GameId, RoomFor, RoomMembership } from "@tetraboard/protocol";
import type {
  FinishedFor,
  FinishedProgress,
  LastRoundFor,
  PlayingFor,
  ProgressError,
  WaitingFor,
} from "./gameProgress";
import type { RoomGamePort } from "./gamePort";

export type ProgressGameTypes = GameTypes & {
  state: { status: "playing"; turn: string } | { status: "finished"; turn: null };
};

export type ProgressPlayingRoom<G extends GameId, T extends ProgressGameTypes> = PlayingFor<G> & {
  game: T["state"] & { status: "playing"; turn: T["seat"] };
};

export type ProgressRoom<G extends GameId, T extends ProgressGameTypes> =
  | ProgressPlayingRoom<G, T>
  | WaitingFor<G>;

export type ProgressCpuJob<T extends ProgressGameTypes> = {
  roundId: string;
  positionRevision: number;
  seat: T["seat"];
  action: T["action"];
  applyAt: number;
};

export type ProgressCpuJobs<T extends ProgressGameTypes> = {
  read(): ProgressCpuJob<T> | undefined;
  write(job: ProgressCpuJob<T>): void;
  delete(): void;
};

type AccountId = (playerId: string) => string | null;

export type PreparedLeave<T extends ProgressGameTypes> = { ok: true; state: T["state"] };

export interface GameProgressStore<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[] = [],
> {
  start(
    room: WaitingFor<G>,
    accountId: AccountId,
    ...args: StartArgs
  ): { room: PlayingFor<G>; roundId: string; at: number };
  recordTransition(room: PlayingFor<G>, transition: GameTransition<T["state"], T["event"]>): void;
  finalize(result: FinishedProgress<G>): LastRoundFor<G>;
  cpuJobs?: ProgressCpuJobs<T>;
}

export interface GameProgressSpec<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[] = [],
  Prepared extends PreparedLeave<T> = PreparedLeave<T>,
> {
  gameId: G;
  definition: GameDefinition<T, G>;
  parseRoom(input: unknown): ProgressRoom<G, T>;
  parseFinishedState(input: T["state"]): FinishedFor<G>;
  seat(player: RoomFor<G>["players"][number]): T["seat"] | null;
  inactiveSeats(state: T["state"]): readonly T["seat"][];
  waitingSeat: RoomGamePort<G>["waitingSeat"];
  unknownPlayerMessage: string;
  toAction(command: GameActionCommandFor<G>): T["action"];
  moveError(reason: T["rejection"]): ProgressError;
  prepareLeaveResult(transition: GameTransition<T["state"], T["event"]>): Prepared;
  preservePositionOnInactiveLeave?: boolean;
  incrementRevisionOnFinish?: boolean;
  clearCpuJobsOnAccept?(): void;
  advanceClock(
    clock: PlayingFor<G>["clock"],
    previousTurn: T["seat"],
    nextTurn: T["seat"],
    at: number,
    turnEnded: boolean,
    timeControl: PlayingFor<G>["settings"]["timeControl"],
  ): PlayingFor<G>["clock"];
  isClockExpired(clock: PlayingFor<G>["clock"], at: number): boolean;
  store: GameProgressStore<G, T, StartArgs>;
  membership(hash: string): RoomMembership | null;
  accountId: AccountId;
  now(): number;
  random?(): number;
}
