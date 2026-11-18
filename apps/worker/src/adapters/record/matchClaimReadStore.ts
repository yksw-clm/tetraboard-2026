import type { ClaimRow, MatchClaimReadStore, MatchRow } from "@tetraboard/context-record";
import { isDeleted } from "../privacy/identity";
export class D1MatchClaimReadStore implements MatchClaimReadStore {
  constructor(private readonly db: D1Database) {}
  isDeleted(accountId: string) {
    return isDeleted(this.db, accountId);
  }
  readState(matchId: string, playerId: string) {
    return this.db
      .prepare(
        "SELECT state,account_id FROM match_participant_accounts WHERE match_id=? AND player_id=?",
      )
      .bind(matchId, playerId)
      .first<Pick<ClaimRow, "state" | "account_id">>();
  }
  readSaved(matchId: string) {
    return this.db
      .prepare("SELECT game,record_json FROM matches WHERE id=?")
      .bind(matchId)
      .first<MatchRow>();
  }
  async readPending(matchId: string) {
    const rows = await this.db
      .prepare("SELECT * FROM match_participant_accounts WHERE match_id=? AND state='pending'")
      .bind(matchId)
      .all<ClaimRow>();
    return rows.results;
  }
}
