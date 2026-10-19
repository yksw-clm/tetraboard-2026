import { profileAvatarUrl } from "./auth";
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
      `SELECT id, name, username, avatarKey, publicProfileId, profileCompleted, isAnonymous FROM user WHERE NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = user.id) AND id IN (${unique.map(() => "?").join(",")})`,
    )
    .bind(...unique)
    .all<Omit<CurrentProfile, "avatarUrl"> & { id: string; avatarKey: string | null }>();
  for (const { id, avatarKey, ...row } of rows.results)
    profiles.set(id, { ...row, avatarUrl: profileAvatarUrl(avatarKey) });
  return profiles;
}
// Handles accounts completed by the previous Worker between migration and deployment.
export async function ensurePublicProfileId(
  db: D1Database,
  accountId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "UPDATE user SET publicProfileId = COALESCE(publicProfileId, ?) WHERE id = ? AND profileCompleted = 1 AND (COALESCE(isAnonymous,0)=0 OR guestNameCustomized=1) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id) RETURNING publicProfileId",
    )
    .bind(crypto.randomUUID(), accountId)
    .first<{ publicProfileId: string }>();
  return row?.publicProfileId ?? null;
}
