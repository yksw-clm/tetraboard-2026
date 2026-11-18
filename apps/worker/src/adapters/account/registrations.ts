import { registrationAccountAllowed } from "./registrationFence";
import type {
  RegistrationStore,
  RegistrationFlow,
  RegistrationIdentity,
} from "@tetraboard/context-account";
export class D1Registrations implements RegistrationStore {
  constructor(private readonly db: D1Database) {}
  async read(id: string) {
    return this.db
      .prepare("SELECT * FROM registration_flows WHERE id=?")
      .bind(id)
      .first<RegistrationFlow>();
  }
  async guestRoomLinkComplete(flow: RegistrationFlow) {
    if (!flow.guest_account_id || !flow.account_id) return false;
    return Boolean(
      await this.db
        .prepare(`SELECT 1 FROM user u WHERE u.id=? AND COALESCE(u.isAnonymous,0)=0
    AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
    AND (u.id=? OR (? IS NOT NULL AND EXISTS (
      SELECT 1 FROM guest_account_merges m WHERE m.guest_id=? AND m.account_id=u.id)))`)
        .bind(
          flow.account_id,
          flow.guest_account_id,
          flow.record_accepted_at_ms,
          flow.guest_account_id,
        )
        .first(),
    );
  }
  async rememberOAuth(flow: RegistrationFlow, state: string, provider: string, now: number) {
    const results = await this.db.batch([
      this.db
        .prepare("DELETE FROM registration_oauth_states WHERE registration_id=?")
        .bind(flow.id),
      this.db
        .prepare(`INSERT INTO registration_oauth_states (state,registration_id,provider,expires_at_ms)
      SELECT ?,id,?,? FROM registration_flows WHERE id=? AND cancelled_at_ms IS NULL AND claim_until_ms>?
        AND account_id IS NULL AND session_id IS NULL RETURNING state`)
        .bind(state, provider, Math.min(flow.claim_until_ms, now + 600_000), flow.id, now),
    ]);
    return Boolean(results[1].results.length);
  }
  async pendingOAuth(state: string, now: number) {
    return this.db
      .prepare(`SELECT registration_id,provider FROM registration_oauth_states
    WHERE state=? AND expires_at_ms>?`)
      .bind(state, now)
      .first<{ registration_id: string; provider: string }>();
  }
  async completeOAuth(
    state: string,
    pending: { registration_id: string; provider: string },
    identity: RegistrationIdentity,
    now: () => number,
  ) {
    await this.db.batch([
      this.db
        .prepare(`UPDATE registration_flows SET account_id=?,session_id=? WHERE id=?
      AND cancelled_at_ms IS NULL AND claim_until_ms>? AND account_id IS NULL AND session_id IS NULL
      AND EXISTS (SELECT 1 FROM registration_oauth_states WHERE state=? AND registration_id=registration_flows.id AND provider=? AND expires_at_ms>?)
      AND ${registrationAccountAllowed("?")}`)
        .bind(
          identity.user.id,
          identity.sessionId,
          pending.registration_id,
          now(),
          state,
          pending.provider,
          now(),
          identity.user.id,
        ),
      this.db.prepare("DELETE FROM registration_oauth_states WHERE state=?").bind(state),
    ]);
  }
  async hasConsent(accountId: string, legalVersion: string) {
    return Boolean(
      await this.db
        .prepare("SELECT 1 FROM legal_consents WHERE account_id=? AND version=?")
        .bind(accountId, legalVersion)
        .first(),
    );
  }
}
