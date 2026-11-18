import {
  oauthLegalConsentLifetimeMs,
  type LegalConsentStore,
  type OAuthLegalConsentStore,
} from "@tetraboard/context-privacy";
import { legalVersion } from "@tetraboard/protocol/privacy";
export function consentStatement(db: D1Database, id: string, version = legalVersion) {
  return db
    .prepare(
      "INSERT INTO legal_consents SELECT id,?,? FROM user WHERE id=? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=user.id) ON CONFLICT(account_id) DO UPDATE SET version=excluded.version,accepted_at_ms=excluded.accepted_at_ms WHERE legal_consents.version != excluded.version",
    )
    .bind(version, Date.now(), id);
}

export class D1LegalConsent implements LegalConsentStore, OAuthLegalConsentStore {
  constructor(private readonly db: D1Database) {}

  async readVersion(accountId: string) {
    const row = await this.db
      .prepare("SELECT version FROM legal_consents WHERE account_id = ?")
      .bind(accountId)
      .first<{ version: string }>();
    return row?.version;
  }

  async saveConsent(accountId: string, version: string, acceptedAt: number) {
    await this.db
      .prepare(
        "INSERT INTO legal_consents VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET version=excluded.version, accepted_at_ms=excluded.accepted_at_ms",
      )
      .bind(accountId, version, acceptedAt)
      .run();
  }

  async rememberOAuthConsent(state: string, provider: string, version: string) {
    await this.db
      .prepare("INSERT INTO oauth_legal_consents VALUES (?,?,?,?,?)")
      .bind(state, provider, version, Date.now(), Date.now() + oauthLegalConsentLifetimeMs)
      .run();
  }

  readOAuthConsent(state: string, now: number) {
    return this.db
      .prepare(
        "SELECT provider,version FROM oauth_legal_consents WHERE state=? AND expires_at_ms>?",
      )
      .bind(state, now)
      .first<{ provider: string; version: string }>();
  }

  async completeOAuthConsent(accountId: string, state: string, version: string) {
    await this.db.batch([
      consentStatement(this.db, accountId, version),
      this.db.prepare("DELETE FROM oauth_legal_consents WHERE state=?").bind(state),
    ]);
  }
}
