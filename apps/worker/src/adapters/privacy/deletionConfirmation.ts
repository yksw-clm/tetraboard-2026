import type {
  DeletionChallengeStarter,
  DeletionProvider,
  DeletionReauthenticationStore,
} from "@tetraboard/context-privacy";
import { digest } from "../../crypto";

export class D1DeletionConfirmation
  implements DeletionChallengeStarter, DeletionReauthenticationStore
{
  constructor(private readonly db: D1Database) {}

  async readFlowAccount(flowId: string, now: number) {
    const flow = await this.db
      .prepare("SELECT account_id FROM deletion_flows WHERE id=? AND expires_at_ms>?")
      .bind(flowId, now)
      .first<{ account_id: string }>();
    return flow?.account_id ?? null;
  }

  async countRecentChallenges(accountId: string, createdAfter: number) {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM deletion_challenges WHERE account_id=? AND created_at_ms>?",
      )
      .bind(accountId, createdAfter)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async readProvider(accountId: string) {
    const account = await this.db
      .prepare(
        "SELECT providerId FROM account WHERE userId=? AND providerId IN ('google','discord')",
      )
      .bind(accountId)
      .first<{ providerId: DeletionProvider }>();
    return account?.providerId ?? null;
  }

  async createChallenge(
    id: string,
    accountId: string,
    provider: DeletionProvider,
    now: number,
    expiresAt: number,
  ) {
    const inserted = await this.db
      .prepare(
        "INSERT INTO deletion_challenges(id,account_id,provider,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?)",
      )
      .bind(id, accountId, provider, now, expiresAt)
      .run();
    return inserted.meta.changes === 1;
  }

  async createFlow(id: string, accountId: string, expiresAt: number) {
    await this.db
      .prepare("INSERT INTO deletion_flows VALUES (?,?,?)")
      .bind(id, accountId, expiresAt)
      .run();
  }

  async rememberOAuthState(id: string, state: string) {
    await this.db
      .prepare("UPDATE deletion_challenges SET oauth_state=? WHERE id=?")
      .bind(state, id)
      .run();
  }

  async readChallenge(id: string, state: string | null, now: number) {
    const row = await this.db
      .prepare(
        "SELECT account_id,provider,created_at_ms FROM deletion_challenges WHERE id=? AND oauth_state=? AND expires_at_ms>? AND verified_at_ms IS NULL",
      )
      .bind(id, state, now)
      .first<{ account_id: string; provider: string; created_at_ms: number }>();
    return row
      ? { accountId: row.account_id, provider: row.provider, createdAtMs: row.created_at_ms }
      : null;
  }

  async verifyChallenge(id: string, state: string | null, sessionId: string, now: number) {
    await this.db
      .prepare(
        "UPDATE deletion_challenges SET verified_at_ms=?,verified_session_id=? WHERE id=? AND oauth_state=? AND verified_at_ms IS NULL",
      )
      .bind(now, sessionId, id, state)
      .run();
  }

  async isVerified(id: string, accountId: string, sessionId: string, now: number) {
    const row = await this.db
      .prepare(
        "SELECT id FROM deletion_challenges WHERE id=? AND account_id=? AND verified_session_id=? AND verified_at_ms IS NOT NULL AND expires_at_ms>?",
      )
      .bind(id, accountId, sessionId, now)
      .first();
    return Boolean(row);
  }

  async consumeChallenge(id: string, accountId: string, sessionId: string, now: number) {
    const row = await this.db
      .prepare(
        "UPDATE deletion_challenges SET verified_at_ms=NULL,verified_session_id=NULL,oauth_state=NULL WHERE id=? AND account_id=? AND verified_session_id=? AND verified_at_ms IS NOT NULL AND expires_at_ms>? RETURNING id",
      )
      .bind(id, accountId, sessionId, now)
      .first();
    return Boolean(row);
  }

  async isSeated(accountId: string) {
    return Boolean(
      await this.db
        .prepare("SELECT 1 FROM account_room_seats WHERE account_id=?")
        .bind(accountId)
        .first(),
    );
  }

  async readDeletionStatus(receipt: string) {
    const row = await this.db
      .prepare("SELECT completed_at_ms FROM deleted_accounts WHERE receipt_hash=?")
      .bind(await digest(receipt))
      .first<{ completed_at_ms: number | null }>();
    if (!row) return null;
    return row.completed_at_ms === null ? "processing" : "complete";
  }

  async cancel(flowId: string, challengeId: string) {
    await this.db.batch([
      this.db.prepare("DELETE FROM deletion_flows WHERE id=?").bind(flowId),
      this.db
        .prepare(
          "UPDATE deletion_challenges SET verified_at_ms=NULL,verified_session_id=NULL,oauth_state=NULL WHERE id=?",
        )
        .bind(challengeId),
    ]);
  }
}
