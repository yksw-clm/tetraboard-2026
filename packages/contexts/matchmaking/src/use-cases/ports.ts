import type { MatchmakingGame, MatchmakingState } from "@tetraboard/protocol";
import type {
  AccountAdmission,
  Group,
  Player,
  Profile,
  State,
  Wait,
  MatchmakingReason,
  MatchmakingStage,
} from "../domain/state";
import type { RatedPolicy } from "../domain/ratedMatchmaking";
export type MatchmakingWrite = { readonly value: unknown };
export type LatestQueueRating = { rating_after: number; sigma_after?: number; rated_games: number };
export type MatchmakingRoomState = {
  phase: "waiting" | "playing" | "closed";
  started: boolean;
  aiUnavailable: boolean;
  occupiedPlayerIds: string[];
  connectedPlayerIds: string[];
  room?: NonNullable<MatchmakingState["previousMatch"]>["room"];
};
export interface MatchmakingStorage {
  save(state: State): void;
  ended(operationId: string): boolean;
  end(operationId: string): void;
  endAndSave(operationId: string, state: State): void;
}
export interface MatchmakingStore {
  profile(accountId: string, rated: boolean): Promise<Profile | null>;
  forget(wait: Wait): Promise<void>;
  restore(wait: Wait): Promise<boolean>;
  releaseWaiting(group: Group): Promise<void>;
  hasSeat(accountId: string, operationId: string): Promise<boolean>;
  hasLease(accountId: string, operationId: string, now: number): Promise<boolean>;
  preparePlayer(player: Player, group: Group, now: number): MatchmakingWrite[];
  commit(writes: MatchmakingWrite[]): Promise<void>;
  clearPending(matchId: string): Promise<void>;
  pendingAccounts(accountIds: string[]): Promise<Set<string>>;
  validWaits(key: string, now: number): Promise<{ operationId: string }[]>;
  join(
    wait: Wait,
    key: string,
    retiredKey: string,
    rated: boolean,
  ): Promise<{ inserted: boolean; latest?: LatestQueueRating }>;
  heartbeat(wait: Wait): Promise<void>;
  occupiedOperations(operationIds: string[]): Promise<string[]>;
}
export interface MatchmakingPorts {
  storage: MatchmakingStorage;
  store: MatchmakingStore;
  credential(wait: Wait, key: string): Promise<{ token: string; tokenHash: string }>;
  releaseReservation(admission: AccountAdmission): Promise<void>;
  reserveMatchSequence(matchId: string, scope: `rated:${MatchmakingGame}`): Promise<number>;
  room(roomId: string): {
    abortMatchmakingRoom(
      matchId: string,
      instanceId: string,
    ): Promise<{ status: "already_started" | "aborted" }>;
    rekeyMatchmakingPlayer(
      matchId: string,
      instanceId: string,
      playerId: string,
      version: number,
      tokenHash: string,
    ): Promise<boolean>;
    prepareMatchmakingRoom(
      input: import("../domain/state").MatchmakingRoomInput,
    ): Promise<{ status: string }>;
    getMatchmakingState(matchId: string, instanceId: string): Promise<MatchmakingRoomState>;
  };
  availableCpuSeats(): Promise<number>;
  now(): number;
  randomId(): string;
  randomRoomId(): string;
  event(wait: Wait, stage: MatchmakingStage, reason: MatchmakingReason, group?: Group): void;
  diagnostic(event: string, data: { diagnosticId: string; atMs: number; matchId?: string }): void;
}
export type MatchmakingRuntime = MatchmakingPorts & {
  game: MatchmakingGame;
  legacy: boolean;
  retired: boolean;
  diagnostics: boolean;
  legacyKey: string;
  queueRules: {
    key: string;
    seats: number;
    fillAfterMs: number;
    leaseMs: number;
    connectionGraceMs: number;
  };
  ratingPolicy?: RatedPolicy;
};
