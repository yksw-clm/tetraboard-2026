import type {
  AccountProfiles,
  StoredProfile,
  CurrentProfileRow,
} from "@tetraboard/context-account";
export class D1AccountProfiles implements AccountProfiles {
  constructor(private db: D1Database) {}
  sessionProfile(id: string) {
    return this.db
      .prepare(
        'SELECT id, name, username, image, profileCompleted, avatarKey, avatarPresetId, profileMessage, favoriteGames, isTestUser, publicProfileId, isAnonymous, guestNameCustomized FROM "user" WHERE id = ? AND COALESCE(isAnonymous, 0) = 0 AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = user.id)',
      )
      .bind(id)
      .first<StoredProfile>();
  }
  async currentProfiles(unique: readonly string[]) {
    const rows = await this.db
      .prepare(
        `SELECT id, name, username, avatarKey, avatarPresetId, publicProfileId, profileCompleted, isAnonymous, profileMessage, favoriteGames FROM user WHERE NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = user.id) AND id IN (${unique.map(() => "?").join(",")})`,
      )
      .bind(...unique)
      .all<CurrentProfileRow>();
    return rows.results;
  }
  async accountId(profileId: string) {
    return (
      (
        await this.db
          .prepare("SELECT id FROM user WHERE publicProfileId = ?")
          .bind(profileId)
          .first<{ id: string }>()
      )?.id ?? null
    );
  }
  async accountIdByUsername(username: string) {
    return (
      (await this.db
        .prepare('SELECT id FROM user WHERE LOWER("username") = ? AND COALESCE(isAnonymous, 0) = 0')
        .bind(username)
        .first<string>("id")) ?? null
    );
  }
  async mergedAccountId(guestId: string) {
    return (
      (
        await this.db
          .prepare("SELECT account_id FROM guest_account_merges WHERE guest_id=?")
          .bind(guestId)
          .first<{ account_id: string }>()
      )?.account_id ?? null
    );
  }
}
