import { accountAvatarUrl } from "./auth";
export type CurrentProfile = {
  name: string;
  username: string | null;
  avatarUrl: string | null;
  publicProfileId: string | null;
  profileCompleted: number;
  isAnonymous: number | null;
};
export async function readCurrentProfiles(
  db: D1Database,
  ids: readonly string[],
): Promise<ReadonlyMap<string, CurrentProfile>> {
  const unique = [...new Set(ids)];
  const profiles = new Map<string, CurrentProfile>();
  if (!unique.length) return profiles;
  const rows = await db
    .prepare(
      `SELECT id, name, username, avatarKey, avatarPresetId, publicProfileId, profileCompleted, isAnonymous FROM user WHERE NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = user.id) AND id IN (${unique.map(() => "?").join(",")})`,
    )
    .bind(...unique)
    .all<
      Omit<CurrentProfile, "avatarUrl"> & {
        id: string;
        avatarKey: string | null;
        avatarPresetId: string | null;
      }
    >();
  for (const { id, avatarKey, avatarPresetId, ...row } of rows.results) {
    profiles.set(id, { ...row, avatarUrl: accountAvatarUrl({ id, avatarKey, avatarPresetId }) });
  }
  return profiles;
}
