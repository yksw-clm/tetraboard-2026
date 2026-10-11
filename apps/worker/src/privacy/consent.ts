import { legalVersion } from "@tetraboard/protocol/privacy";
export function consentStatement(db: D1Database, id: string) {
  return db
    .prepare(
      "INSERT INTO legal_consents SELECT id,?,? FROM user WHERE id=? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=user.id) ON CONFLICT(account_id) DO UPDATE SET version=excluded.version,accepted_at_ms=excluded.accepted_at_ms WHERE legal_consents.version != excluded.version",
    )
    .bind(legalVersion, Date.now(), id);
}
