import type { GameId } from "@tetraboard/protocol";
import { readMatchChunks } from "../domain/matchChunks";
import { verifyFinalState } from "../domain/snapshotMatch";
import { matchDetail, matchSummary, publicMatchDetail } from "../domain/matchData";
import type { ParticipantProfiles, StoredMatch, RecordMatch } from "../domain/matchData";
import { withMatchKind } from "../domain/matchKinds";
import type { HistoryQuery, MatchReadStore, MatchRow } from "./readPorts";

export type MatchReadValidation<D extends StoredMatch, R extends RecordMatch> = {
  readStored(json: string, game: string): D;
  readComplete(json: string, game: string): R;
  parseEvent(game: GameId, event: unknown): unknown;
  rebuildMatch(match: D, events: unknown[]): unknown;
};
export type MatchReadOptions = { includeMoveCount?: boolean; includeMatchKind?: boolean };
export type LoadProfiles<D> = (records: D[]) => Promise<ParticipantProfiles>;

export async function readPublicMatchMetadata<D extends StoredMatch>(
  store: Pick<MatchReadStore, "readMatch">,
  matchId: string,
  decode: (json: string, game: string) => D,
) {
  const row = await store.readMatch(matchId);
  if (!row) return null;
  const match = decode(row.record_json, row.game);
  if (match.record.id !== matchId) throw new Error("Stored match ID mismatch");
  return { id: match.record.id, game: match.game };
}

export async function readMatchDetailRecord<D extends StoredMatch, R extends RecordMatch>(
  store: MatchReadStore,
  row: MatchRow,
  validation: MatchReadValidation<D, R>,
): Promise<R> {
  const match = validation.readStored(row.record_json, row.game);
  if (match.game === "shogi" || match.game === "four-shogi")
    return validation.readComplete(row.record_json, row.game);
  const rows = await store.readDetailChunks(match.record.id);
  const parse = (event: unknown) => validation.parseEvent(match.game, event);
  const events = readMatchChunks(rows, match.record.replay.eventCount, parse);
  const restored = validation.readComplete(
    JSON.stringify(validation.rebuildMatch(match, events)),
    row.game,
  );
  if (restored.game !== "shogi" && restored.game !== "four-shogi")
    verifyFinalState(restored.record);
  return restored;
}
export async function readMatchHistory<D extends StoredMatch>(
  store: MatchReadStore,
  query: HistoryQuery,
  decode: (json: string, game: string) => D,
  loadProfiles: LoadProfiles<D>,
  options: MatchReadOptions = {},
) {
  const rows = await store.readHistory(query);
  const records = rows.slice(0, 20).map((row) => decode(row.record_json, row.game));
  const matches = await summaries(store, records, loadProfiles, options);
  const last = matches.at(-1);
  return {
    matches,
    nextCursor: rows.length > 20 && last ? `${last.startedAtMs}:${last.id}` : null,
    ...(query.filter === "all" ? {} : { filter: query.filter }),
  };
}
export async function readPublicMatches<D extends StoredMatch>(
  store: MatchReadStore,
  game: GameId | undefined,
  humanOnly: boolean,
  decode: (json: string, game: string) => D,
  loadProfiles: LoadProfiles<D>,
  options: MatchReadOptions = {},
) {
  const rows = await store.readPublic(game, humanOnly);
  const records = rows.map((row) => decode(row.record_json, row.game));
  return { matches: await summaries(store, records, loadProfiles, options) };
}
async function summaries<D extends StoredMatch>(
  store: MatchReadStore,
  records: D[],
  loadProfiles: LoadProfiles<D>,
  options: MatchReadOptions,
) {
  const profiles = await loadProfiles(records);
  const kinds = options.includeMatchKind
    ? await store.readKinds(records.map(({ record }) => record.id))
    : undefined;
  return records.map((record) =>
    withMatchKind(matchSummary(record, profiles, options.includeMoveCount), kinds),
  );
}
export async function readMatchDetail<D extends StoredMatch, R extends RecordMatch>(
  store: MatchReadStore,
  matchId: string,
  accountId: string | undefined,
  validation: MatchReadValidation<D, R>,
  loadProfiles: LoadProfiles<R>,
  includeMatchKind = false,
) {
  const row = await store.readMatch(matchId, accountId);
  if (!row) return null;
  const match = await readMatchDetailRecord(store, row, validation);
  const profiles = await loadProfiles([match]);
  const self =
    accountId === undefined
      ? undefined
      : match.record.participants.find((p) => p.kind === "human" && p.accountId === accountId);
  if (accountId !== undefined && !self) throw new Error("Match participant missing");
  const kinds = includeMatchKind ? await store.readKinds([match.record.id]) : undefined;
  const detail = self ? matchDetail(match, self.id, profiles) : publicMatchDetail(match, profiles);
  return { match: withMatchKind(detail, kinds) };
}
