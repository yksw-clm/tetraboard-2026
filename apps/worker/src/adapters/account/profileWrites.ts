import type { ProfileWriter, ProfileSave, SavedProfile } from "@tetraboard/context-account";
import { consentStatement } from "../privacy/consent";
export class D1ProfileWriter implements ProfileWriter {
  constructor(private db: D1Database) {}
  async save(command: ProfileSave): Promise<SavedProfile | null> {
    const results = await this.db.batch<SavedProfile>(this.statements(command));
    return results[0].results.length === 1 ? results[0].results[0]! : null;
  }
  private statements(command: ProfileSave) {
    const { user, avatarKey, consent, uploadedKey } = command;
    return [
      // 旧フォームの省略項目はDBの現在値を保持し、空文字・空配列は明示的な削除にします。
      this.update(command),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO avatar_deletions (key) SELECT ? WHERE ? IS NOT NULL AND ? IS NOT ? AND changes() = 1",
        )
        .bind(user.avatarKey, user.avatarKey, user.avatarKey, avatarKey),
      ...(consent ? [consentStatement(this.db, user.id)] : []),
      ...(uploadedKey
        ? [
            this.db
              .prepare(
                "DELETE FROM avatar_deletions WHERE key=? AND EXISTS(SELECT 1 FROM user WHERE id=? AND avatarKey=?)",
              )
              .bind(uploadedKey, user.id, uploadedKey),
          ]
        : []),
    ];
  }
  private update(command: ProfileSave) {
    const {
      user,
      input,
      details,
      image,
      avatarKey,
      avatarPresetId,
      publicProfileId,
      expectedCompleted,
      registration,
      now,
    } = command;
    return this.db
      .prepare(`UPDATE user SET name = ?, username = ?, profileCompleted = 1, image = ?, avatarKey = ?, avatarPresetId = ?, profileMessage = COALESCE(?, profileMessage), favoriteGames = COALESCE(?, favoriteGames), updatedAt = ?, publicProfileId = COALESCE(publicProfileId, ?)
        WHERE id = ? AND COALESCE(profileCompleted, 0) = ? AND avatarKey IS ? AND avatarPresetId IS ? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=user.id)
        ${
          registration
            ? `AND EXISTS (SELECT 1 FROM registration_flows f JOIN session s ON s.id=f.session_id AND s.userId=f.account_id
          WHERE f.id=? AND f.account_id=user.id AND f.session_id=? AND f.cancelled_at_ms IS NULL AND f.claim_until_ms>? AND s.expiresAt>?)`
            : ""
        }
        RETURNING id, publicProfileId, profileMessage, favoriteGames`)
      .bind(
        input.name,
        input.username,
        image,
        avatarKey,
        avatarPresetId,
        details.profileMessage ?? null,
        details.favoriteGames === undefined ? null : JSON.stringify(details.favoriteGames),
        new Date(now).toISOString(),
        publicProfileId,
        user.id,
        expectedCompleted,
        user.avatarKey,
        user.avatarPresetId ?? null,
        ...(registration
          ? [registration.id, registration.session_id, now, new Date(now).toISOString()]
          : []),
      );
  }
}
