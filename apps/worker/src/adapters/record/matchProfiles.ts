import {
  readMatchProfiles,
  resolveMatchParticipantList,
  type MatchParticipantClaim,
  type MatchParticipantReader,
} from "@tetraboard/context-record";
import { readCurrentProfiles } from "@tetraboard/context-account";
import { D1AccountProfiles } from "../account/profiles";
import { profilePolicy } from "../account/profilePolicy";
import { redactRetiredParticipants } from "../../privacy/identity";
import type { ReadableMatch } from "./matchDataContracts";

function matchParticipantReader(db: D1Database): MatchParticipantReader {
  return {
    async readClaims(matchIds) {
      const rows = await db
        .prepare(
          `SELECT match_id,player_id,account_id,state FROM match_participant_accounts
      WHERE match_id IN (${matchIds.map(() => "?").join(",")}) AND state IN ('applied','retired')`,
        )
        .bind(...matchIds)
        .all<MatchParticipantClaim>();
      return rows.results;
    },
    async readDeleted(accountIds) {
      const rows = await db
        .prepare(
          `SELECT id FROM deleted_accounts WHERE id IN (${accountIds.map(() => "?").join(",")})`,
        )
        .bind(...accountIds)
        .all<{ id: string }>();
      return rows.results.map((row) => row.id);
    },
  };
}

export function resolveMatchParticipants(db: D1Database, record: ReadableMatch): Promise<void> {
  return resolveMatchParticipantList(
    matchParticipantReader(db),
    [record],
    redactRetiredParticipants,
  );
}

export function participantProfiles(db: D1Database, records: ReadableMatch[]) {
  return readMatchProfiles(
    matchParticipantReader(db),
    records,
    (ids) => readCurrentProfiles(new D1AccountProfiles(db), profilePolicy, ids),
    redactRetiredParticipants,
  );
}
