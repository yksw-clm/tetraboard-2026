import type { State, Waiting, Player, Group } from "../domain/queue";
import type {
  TournamentAdmission,
  PrepareTournamentRoomInput,
  RekeyTournamentPlayerInput,
} from "../domain/room";
import type { TournamentInput, TournamentSettings } from "@tetraboard/protocol";
import type { GameScope } from "@tetraboard/protocol/games";
import type { TournamentSettingsPolicy } from "../domain/settings";
import type { TournamentRow, PublicCounts, ScoreRow, InternalStanding } from "../domain/types";
import type { TournamentRoomContext } from "../domain/room";
import type { TournamentMatchRecord, TournamentPoints } from "../domain/result";
export interface TournamentPolicy extends TournamentSettingsPolicy {
  avatarUrl(row: ScoreRow): string | null;
  pointsUnits: readonly number[];
}
export interface TournamentReader {
  read(key: string): Promise<TournamentRow | null>;
  public(id: number): Promise<TournamentRow | null>;
  entryCount(key: string): Promise<number>;
  counts(
    key: string,
  ): Promise<{ playing: number | null; pending: number | null; completed: number | null } | null>;
  waitingCount(key: string, now: number): Promise<number>;
  lobbyRows(
    game: GameScope,
    now: number,
    cutoff: number,
  ): Promise<(TournamentRow & PublicCounts)[]>;
  listRows(
    game: GameScope,
    cursor: string | undefined,
  ): Promise<(TournamentRow & { entryCount: number })[]>;
  winnerRows(keys: string[]): Promise<(ScoreRow & { tournamentKey: string })[]>;
  scoreRows(row: TournamentRow): Promise<ScoreRow[]>;
  adminRows(offset: number): Promise<TournamentRow[]>;
}
export type TournamentReadPorts = {
  store: TournamentReader;
  policy: TournamentPolicy;
  now(): number;
};
export interface TournamentDraftStore {
  create(input: TournamentInput, key: string, now: number): Promise<void>;
  update(key: string, input: TournamentInput, version: number, now: number): Promise<boolean>;
}
export type FinalizationGuard = { key: string; entries: number };
export interface TournamentFinalization<Write> {
  pending(key: string): Promise<boolean>;
  rank(standing: InternalStanding, guard: FinalizationGuard): Write;
  notification(
    standing: InternalStanding,
    payload: { id: number | null; name: string; rank: number | null; tied: boolean },
    now: number,
    guard: FinalizationGuard,
  ): Write;
  finish(key: string, now: number, guard: FinalizationGuard): Write;
  batch(writes: Write[]): Promise<void>;
}
export interface TournamentPublication<Write> {
  points(
    context: TournamentRoomContext,
    record: TournamentMatchRecord,
    game: TournamentSettings["game"],
    points: TournamentPoints,
  ): Write;
  saved(context: TournamentRoomContext, record: TournamentMatchRecord, now: number): Write;
}

export interface TournamentEntryStore {
  eligible(
    accountId: string,
    key: string,
  ): Promise<{
    id: string;
    name: string;
    avatarKey: string | null;
    avatarPresetId: string | null;
    entryId: string;
  } | null>;
  insert(key: string, accountId: string, id: string, now: number): Promise<void>;
}

export type WaitingProfile = {
  id: string;
  name: string;
  isAnonymous: number | null;
  avatarKey: string | null;
  avatarPresetId: string | null;
  entryId: string;
  operationId: string;
};
export type ParticipationProfile = {
  waitingOperation: string | null;
  leaseUntilMs: number | null;
  seatOperation: string | null;
  endsAtMs: number;
};
export type TournamentCoordinatorWrite = { readonly value: unknown };
export interface TournamentQueueStore {
  waitingProfiles(key: string): Promise<Map<string, WaitingProfile>>;
  leaseValid(wait: Waiting, key: string): Promise<boolean>;
  forget(wait: Waiting): Promise<void>;
  restore(player: Player, key: string): Promise<void>;
  preparePlayer(player: Player, profile: WaitingProfile, key: string): TournamentCoordinatorWrite[];
  commit(writes: TournamentCoordinatorWrite[]): Promise<void>;
  releaseWaiting(players: Player[]): Promise<void>;
  roomUsed(roomId: string): Promise<boolean>;
  ensureGroup(state: State, group: Group): Promise<void>;
  markAborted(group: Group): Promise<void>;
  markPlaying(group: Group, startedAtMs: number): Promise<void>;
  ledgerPhase(group: Group): Promise<{ phase: string } | null>;
  occupied(group: Group): Promise<boolean>;
  participation(key: string, accountId: string): Promise<ParticipationProfile | null>;
  enqueue(wait: Waiting, key: string): Promise<void>;
  heartbeat(wait: Waiting, expiresAtMs: number): Promise<boolean>;
  latestPublished(): Promise<{ id: number | null; ends: number | null } | null>;
  publish(key: string, version: number, publicId: number, now: number): Promise<boolean>;
}
export interface TournamentQueueStorage {
  save(state: State): void;
  cancelled(key: string): boolean;
  cancel(key: string): void;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export type TournamentQueueRuntime = {
  storage: TournamentQueueStorage;
  store: TournamentQueueStore;
  read(key: string): Promise<TournamentRow | null>;
  eligible: TournamentEntryStore["eligible"];
  finalize(key: string): Promise<void>;
  settings(row: TournamentRow): TournamentSettings;
  credential(input: {
    accountId: string;
    tournamentKey: string;
    operationId: string;
    controllerId: string;
    controllerVersion: number;
  }): Promise<{ token: string; tokenHash: string }>;
  avatar(profile: WaitingProfile): Pick<TournamentAdmission, "avatarKey" | "avatarPresetId">;
  releaseReservation(admission: TournamentAdmission): Promise<void>;
  reserveMatchSequence(id: string, scope: `tournament:${string}`): Promise<number>;
  refresh(key: string): Promise<void>;
  room(roomId: string): {
    abortTournamentRoom(id: string, excluded: string[]): Promise<{ status: string }>;
    prepareTournamentRoom(input: PrepareTournamentRoomInput): Promise<{ status: string }>;
    rekeyTournamentPlayer(input: RekeyTournamentPlayerInput): Promise<{ status: string }>;
    getTournamentReservationState(id: string): Promise<{
      status: string;
      startedAtMs?: number;
      connectedPlayerIds: string[];
    }>;
  };
  rules: { leaseMs: number; connectionGraceMs: number };
  now(): number;
  randomId(): string;
  randomRoomId(): string;
  random(bound: number): number;
};
export interface TournamentRecoveryPorts {
  expireWaiting(): Promise<void>;
  pending(): Promise<{ key: string }[]>;
  refresh(key: string): Promise<void>;
}
