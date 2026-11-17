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
