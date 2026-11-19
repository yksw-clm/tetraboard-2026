import type {
  ClaimRow,
  MatchClaimGuard,
  MatchClaimInput,
  MatchClaimStore,
} from "@tetraboard/context-record";
import {
  accountNotDeletedSql,
  deletionGuard,
  deletedAccountExistsSql,
  type DeletionScope,
} from "../../db/deletionGuard";
import { D1MatchClaimReadStore } from "./matchClaimReadStore";
import { mergedAccountIdSql } from "./guestMerges";
import { scrubRetiredMatchClaimStatements } from "./privacyScrub";

export class D1MatchClaimStore
  extends D1MatchClaimReadStore
  implements MatchClaimStore<D1PreparedStatement>
{
  constructor(
    private readonly database: D1Database,
    readonly badges: MatchClaimStore<D1PreparedStatement>["badges"],
  ) {
    super(database);
  }

  async accept(input: MatchClaimInput, now: number, guard?: MatchClaimGuard) {
    const db = this.database;
    await db.batch([
      db
        .prepare(`INSERT OR IGNORE INTO match_participant_accounts
      (match_id,player_id,account_id,room_id,instance_id,state,accepted_at_ms,retry_at_ms)
      SELECT ?,?,id,?,?,'pending',?,? FROM user WHERE id=? AND profileCompleted=1
        AND ${accountNotDeletedSql("user.id")}
        ${
          guard
            ? `AND EXISTS(SELECT 1 FROM registration_flows f JOIN session s ON s.id=f.session_id AND s.userId=f.account_id
          WHERE f.id=? AND f.session_id=? AND f.account_id=user.id AND f.cancelled_at_ms IS NULL
          AND f.claim_until_ms>? AND s.expiresAt>?)`
            : ""
        }`)
        .bind(
          input.matchId,
          input.playerId,
          input.roomId,
          input.instanceId,
          now,
          now,
          input.accountId,
          ...(guard
            ? [guard.registrationId, guard.sessionId, now, new Date(now).toISOString()]
            : []),
        ),
      db
        .prepare(`INSERT OR IGNORE INTO privacy_room_accounts(account_id,room_id)
      SELECT account_id,room_id FROM match_participant_accounts c
      WHERE match_id=? AND player_id=? AND account_id=? AND NOT ${deletedAccountExistsSql("c.account_id")}`)
        .bind(input.matchId, input.playerId, input.accountId),
    ]);
  }

  readAccepted(matchId: string, playerId: string) {
    return this.database
      .prepare("SELECT * FROM match_participant_accounts WHERE match_id=? AND player_id=?")
      .bind(matchId, playerId)
      .first<ClaimRow>();
  }

  transition(matchId: string, row: ClaimRow, valid: boolean) {
    return this.database
      .prepare(`UPDATE match_participant_accounts SET state='${valid ? "applied" : "rejected"}'${valid ? "" : ",account_id=NULL"}
      WHERE match_id=? AND player_id=? AND account_id=? AND room_id=? AND instance_id=? AND state='pending'
        AND EXISTS(SELECT 1 FROM user u WHERE u.id=account_id AND u.profileCompleted=1)
        AND ${accountNotDeletedSql("match_participant_accounts.account_id")}`)
      .bind(matchId, row.player_id, row.account_id, row.room_id, row.instance_id);
  }

  history(matchId: string) {
    return this.database
      .prepare(`INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game)
      SELECT ${mergedAccountIdSql("c.account_id")},m.id,m.mode,m.started_at_ms,m.game
      FROM match_participant_accounts c JOIN matches m ON m.id=c.match_id
      WHERE c.match_id=? AND c.state='applied'
        AND ${accountNotDeletedSql(mergedAccountIdSql("c.account_id"))}
      ON CONFLICT(account_id,match_id) DO NOTHING`)
      .bind(matchId);
  }

  async save(statements: D1PreparedStatement[]) {
    await this.database.batch(statements);
  }

  async findPendingRetries(now: number, roomId?: string) {
    const rows = await this.database
      .prepare(`SELECT match_id FROM match_participant_accounts
    WHERE state='pending' AND retry_at_ms<=? ${roomId ? "AND room_id=?" : ""}
    GROUP BY match_id ORDER BY MIN(retry_at_ms),MIN(accepted_at_ms) LIMIT 25`)
      .bind(now, ...(roomId ? [roomId] : []))
      .all<{ match_id: string }>();
    return rows.results.map((row) => row.match_id);
  }

  async postponeRetry(matchId: string, retryAt: number) {
    await this.database
      .prepare(`UPDATE match_participant_accounts SET retry_at_ms=? WHERE match_id=? AND state='pending'
        AND ${accountNotDeletedSql("match_participant_accounts.account_id")}`)
      .bind(retryAt, matchId)
      .run();
  }
}

export function retireDeletedAccountClaimStatements(db: D1Database, deletion: DeletionScope) {
  const guard = deletionGuard(deletion);
  return [
    ...scrubRetiredMatchClaimStatements(db, deletion),
    db
      .prepare(`UPDATE match_participant_accounts SET state='retired',account_id=NULL
      WHERE account_id=?1 AND ${guard.sql}`)
      .bind(...guard.params()),
  ];
}
