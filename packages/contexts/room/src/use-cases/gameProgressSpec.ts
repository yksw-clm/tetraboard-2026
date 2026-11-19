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
  game: { status: "playing"; turn: T["seat"] };
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

export type ProgressTransition<T extends ProgressGameTypes> = GameTransition<
  T["state"],
  T["event"]
>;
export type SavedProgressState<G extends GameId> = PlayingFor<G>["game"] | FinishedFor<G>;

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
  recordTransition(
    room: PlayingFor<G>,
    transition: ProgressTransition<T>,
  ): SavedProgressState<G> | void;
  finalize(result: FinishedProgress<G>): LastRoundFor<G>;
  cpuJobs?: ProgressCpuJobs<T>;
  loadTransition?(
    room: PlayingFor<G>,
    operation: "play" | "eliminate",
  ): { state: T["state"]; history?: T["history"] };
}

type StateFromRoom<G extends GameId, T extends ProgressGameTypes> = (
  game: ProgressPlayingRoom<G, T>["game"],
) => T["state"];

export type GameProgressSpec<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[] = [],
  Prepared extends PreparedLeave<T> = PreparedLeave<T>,
> = GameProgressOptions<G, T, StartArgs, Prepared> &
  (ProgressPlayingRoom<G, T>["game"] extends T["state"]
    ? { stateFromRoom?: StateFromRoom<G, T> }
    : { stateFromRoom: StateFromRoom<G, T> });

interface GameProgressOptions<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[],
  Prepared extends PreparedLeave<T>,
> {
  gameId: G;
  definition: GameDefinition<T, G>;
  parseRoom(input: unknown): ProgressRoom<G, T>;
  parseFinishedState(input: T["state"], saved?: SavedProgressState<G>): FinishedFor<G>;
  seat(player: RoomFor<G>["players"][number]): T["seat"] | null;
  inactiveSeats(game: ProgressPlayingRoom<G, T>["game"]): readonly T["seat"][];
  waitingSeat: RoomGamePort<G>["waitingSeat"];
  unknownPlayerMessage: string;
  useActionRules?: boolean;
  toAction(command: GameActionCommandFor<G>): T["action"];
  moveError(reason: T["rejection"], action: T["action"]): ProgressError;
  prepareLeaveResult(transition: ProgressTransition<T>): Prepared;
  preservePositionOnInactiveLeave?: boolean;
  updatePlayersOnElimination?: boolean;
  incrementRevisionOnFinish?: boolean;
  clearCpuJobsOnAccept?(): void;
  playingFields?(state: T["state"]): Partial<PlayingFor<G>>;
  waitingFields?: Partial<WaitingFor<G>>;
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

export function readProgressState<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[],
  Prepared extends PreparedLeave<T>,
>(spec: GameProgressSpec<G, T, StartArgs, Prepared>, room: ProgressPlayingRoom<G, T>): T["state"] {
  // 公開局面をルールに直接渡せない場合は、spec が変換を持ちます。
  return spec.stateFromRoom ? spec.stateFromRoom(room.game) : (room.game as T["state"]);
}
