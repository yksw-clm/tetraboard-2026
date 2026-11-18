import type {
  TournamentFinalization,
  InternalStanding,
  FinalizationGuard,
} from "@tetraboard/context-tournament";
import { notificationRecipientAllowedSql } from "../community/notifications";

const guard = `NOT EXISTS(SELECT 1 FROM tournament_matches WHERE tournament_key=? AND phase IN ('reserved','playing','saving'))
    AND (SELECT COUNT(*) FROM tournament_entries WHERE tournament_key=? AND deleted=0)=?
    AND EXISTS(SELECT 1 FROM tournaments WHERE key=? AND finalized_at_ms IS NULL)`;

const guardValues = (v: FinalizationGuard) => [v.key, v.key, v.entries, v.key];
export class D1TournamentFinalization implements TournamentFinalization<D1PreparedStatement> {
  constructor(private db: D1Database) {}
  async pending(key: string) {
    return !!(await this.db
      .prepare(
        "SELECT 1 FROM tournament_matches WHERE tournament_key=? AND phase IN ('reserved','playing','saving') LIMIT 1",
      )
      .bind(key)
      .first());
  }
  rank(v: InternalStanding, snapshot: FinalizationGuard) {
    return this.db
      .prepare(`UPDATE tournament_scores SET final_rank=? WHERE entry_id=? AND ${guard}`)
      .bind(v.rank, v.entryId, ...guardValues(snapshot));
  }
  notification(
    v: InternalStanding,
    payload: { id: number | null; name: string; rank: number | null; tied: boolean },
    now: number,
    snapshot: FinalizationGuard,
  ) {
    return this.db
      .prepare(`INSERT OR IGNORE INTO notification_events(kind,source_id,account_id,created_at_ms,payload_json)
        SELECT 'tournament',?,?2,?,? WHERE (${guard}) AND ${notificationRecipientAllowedSql("?2")}`)
      .bind(v.entryId, v.accountId, now, JSON.stringify(payload), ...guardValues(snapshot));
  }
  finish(key: string, now: number, snapshot: FinalizationGuard) {
    return this.db
      .prepare(
        `UPDATE tournaments SET finalized_at_ms=?,updated_at_ms=? WHERE key=? AND ends_at_ms<=? AND finalized_at_ms IS NULL AND ${guard}`,
      )
      .bind(now, now, key, now, ...guardValues(snapshot));
  }
  async batch(writes: D1PreparedStatement[]) {
    await this.db.batch(writes);
  }
}
