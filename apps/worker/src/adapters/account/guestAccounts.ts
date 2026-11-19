import { guestLifetimeMs } from "@tetraboard/context-account";
import type {
  GuestAccountStore,
  GuestCreation,
  GuestNameChange,
} from "@tetraboard/context-account";
import { consentStatement } from "../privacy/consent";
export class D1GuestAccounts implements GuestAccountStore {
  constructor(private readonly db: D1Database) {}
  async create({ user, now, hash, username }: GuestCreation) {
    const id = user.id;
    // ID・本人資格・同意を同時に確定し、中断時にもID未設定のゲストを残しません。
    await this.db.batch([
      this.db
        .prepare(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isAnonymous,username,profileCompleted,guestNameCustomized,publicProfileId,avatarPresetId)
          VALUES(?,?,?,0,?,?,1,?,1,?,?,?)`)
        .bind(
          id,
          user.name,
          `${id}@guest.invalid`,
          new Date(now).toISOString(),
          new Date(now).toISOString(),
          username,
          user.guestNameCustomized,
          user.publicProfileId,
          user.avatarPresetId,
        ),
      this.db
        .prepare("INSERT INTO guest_sessions(token_hash,account_id,expires_at_ms) VALUES(?,?,?)")
        .bind(hash, id, now + guestLifetimeMs),
      consentStatement(this.db, id),
    ]);
  }
  customize({ user, name, avatarPresetId, updatedAt }: GuestNameChange) {
    return this.db
      .prepare(
        "UPDATE user SET name=?,avatarPresetId=?,guestNameCustomized=1,updatedAt=? WHERE id=? AND isAnonymous=1 AND guestNameCustomized=0 AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id) RETURNING id",
      )
      .bind(name, avatarPresetId ?? user.avatarPresetId ?? null, updatedAt, user.id)
      .first();
  }
  rename({ user, name, avatarPresetId, updatedAt }: GuestNameChange) {
    return this.db
      .prepare(
        "UPDATE user SET name=?,avatarPresetId=?,guestNameCustomized=1,updatedAt=? WHERE id=? AND isAnonymous=1 AND avatarPresetId IS ? AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id) RETURNING id",
      )
      .bind(name, avatarPresetId, updatedAt, user.id, user.avatarPresetId ?? null)
      .first();
  }
  rate(key: string, now: number) {
    return this.db
      .prepare(`INSERT INTO rateLimit(id,key,count,lastRequest) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN lastRequest<? THEN 1 ELSE count+1 END,lastRequest=CASE WHEN lastRequest<? THEN excluded.lastRequest ELSE lastRequest END RETURNING count`)
      .bind(key, key, now, now - 60000, now - 60000)
      .first<{ count: number }>();
  }
  async clear(hash: string) {
    if (hash)
      await this.db.batch([
        this.db.prepare("DELETE FROM guest_oauth_flows WHERE guest_token_hash=?").bind(hash),
        this.db.prepare("DELETE FROM guest_sessions WHERE token_hash=?").bind(hash),
      ]);
  }
  async suspend(hash: string, now: number) {
    if (hash)
      await this.db
        .prepare(
          "UPDATE guest_sessions SET registered_at_ms=? WHERE token_hash=? AND registered_at_ms IS NULL",
        )
        .bind(now, hash)
        .run();
  }
}
