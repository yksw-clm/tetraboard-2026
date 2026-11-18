import type { ParticipantProfiles, ReadableRecordMatch } from "../domain/matchData";
import {
  applyParticipantClaims,
  indexMatchClaims,
  participantAccountIds,
  type MatchParticipantClaim,
} from "../domain/matchProfiles";

export interface MatchParticipantReader {
  readClaims(matchIds: string[]): Promise<MatchParticipantClaim[]>;
  readDeleted(accountIds: string[]): Promise<string[]>;
}
type RedactParticipants<R> = (
  record: R,
  retiredPlayers: ReadonlySet<string>,
  deleted: ReadonlySet<string>,
) => R;

/** 保存済み JSON は変えず、一覧の本人関係と退会状態を読取り用に重ねます。 */
export async function resolveMatchParticipantList<D extends ReadableRecordMatch>(
  reader: MatchParticipantReader,
  records: D[],
  redact: RedactParticipants<D["record"]>,
): Promise<void> {
  const matchIds = [...new Set(records.map(({ record }) => record.id))];
  if (!matchIds.length) return;
  const { claims, retiredPlayers } = indexMatchClaims(await reader.readClaims(matchIds));
  for (const match of records)
    match.record = applyParticipantClaims(match.record, claims.get(match.record.id));

  const accountIds = participantAccountIds(records);
  const deleted = new Set(accountIds.length ? await reader.readDeleted(accountIds) : []);
  for (const match of records)
    match.record = redact(match.record, retiredPlayers.get(match.record.id) ?? new Set(), deleted);
}

export async function readMatchProfiles<D extends ReadableRecordMatch>(
  reader: MatchParticipantReader,
  records: D[],
  readCurrent: (accountIds: string[]) => Promise<ParticipantProfiles>,
  redact: RedactParticipants<D["record"]>,
): Promise<ParticipantProfiles> {
  await resolveMatchParticipantList(reader, records, redact);
  const current = await readCurrent(participantAccountIds(records));
  return new Map([...current].map(([id, { name, avatarUrl }]) => [id, { name, avatarUrl }]));
}
