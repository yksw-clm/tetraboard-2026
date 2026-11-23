import * as tournament from "@tetraboard/context-tournament";
import type { TournamentDefinition, TournamentInput } from "@tetraboard/protocol";
import type { GameScope } from "@tetraboard/protocol/games";
import { D1TournamentReader } from "./reader";
import { D1TournamentDrafts } from "./drafts";
import { D1TournamentPublication } from "./publication";
import { D1TournamentFinalization } from "./finalization";
import { tournamentPolicy as policy } from "./policy";
export type { TournamentRow, InternalStanding } from "@tetraboard/context-tournament";
export { cursorOffset, nextOffset } from "@tetraboard/context-tournament";
import type {
  TournamentRow,
  TournamentRoomContext,
  TournamentMatchRecord,
} from "@tetraboard/context-tournament";
const ports = (db: D1Database) => ({ store: new D1TournamentReader(db), policy, now: Date.now });
export const settingsForTournament = (row: TournamentRow) =>
  tournament.settingsForTournament(row, policy);
export const tournamentSettingsMatch = (row: TournamentRow, definition: TournamentDefinition) =>
  tournament.tournamentSettingsMatch(row, definition, policy);
export const stage = (row: TournamentRow, now = Date.now()) => tournament.stage(row, now);
export const readTournament = (db: D1Database, key: string) => ports(db).store.read(key);
export const publicTournament = (db: D1Database, id: number) => ports(db).store.public(id);
export const entryCount = (db: D1Database, key: string) => ports(db).store.entryCount(key);
export const record = (db: D1Database, row: TournamentRow) => tournament.record(ports(db), row);
export const publicSummary = (db: D1Database, row: TournamentRow, now = Date.now()) =>
  tournament.publicSummary(ports(db), row, now);
export const lobbySections = (db: D1Database, game: GameScope, now: number) =>
  tournament.lobbySections(ports(db), game, now);
export const publicTournamentList = (
  db: D1Database,
  game: GameScope,
  cursor: string | undefined,
  now: number,
) => tournament.publicTournamentList(ports(db), game, cursor, now);
export const publicTournamentPages = (db: D1Database, now = Date.now()) =>
  tournament.publicTournamentPages(new D1TournamentReader(db), policy, now);
export const publicFinalStandings = (db: D1Database, row: TournamentRow) =>
  tournament.publicFinalStandings(ports(db), row);
export const createDraft = (db: D1Database, input: TournamentInput) =>
  tournament.createDraft(new D1TournamentDrafts(db), input, {
    id: () => crypto.randomUUID(),
    now: Date.now,
  });
export const updateDraft = (db: D1Database, key: string, input: TournamentInput, version: number) =>
  tournament.updateDraft(new D1TournamentDrafts(db), key, input, version, Date.now);
export const adminList = (db: D1Database, offset: number) =>
  tournament.adminList(ports(db), offset);
export const allStandings = (db: D1Database, row: TournamentRow) =>
  tournament.allStandings(ports(db), row);
export const standingsPage = (
  db: D1Database,
  row: TournamentRow,
  viewer: string | undefined,
  all = false,
  offset = 0,
  includeProfiles = false,
) => tournament.standingsPage(ports(db), row, viewer, all, offset, includeProfiles);
export const finalizeTournament = (db: D1Database, key: string, now = Date.now()) =>
  tournament.finalizeTournament(ports(db), new D1TournamentFinalization(db), key, now);
export const tournamentMatchStatements = (
  db: D1Database,
  context: TournamentRoomContext,
  record: TournamentMatchRecord,
) =>
  tournament.prepareTournamentMatch(
    new D1TournamentPublication(db),
    context,
    record,
    policy,
    Date.now,
  );
