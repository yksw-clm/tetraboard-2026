import type { DecodedMatch } from "./matchDataContracts";
import { profileAvatarUrl } from "./auth";

export async function participantAvatars(db: D1Database, records: DecodedMatch[]) {
  const accountIds = [
    ...new Set(
      records.flatMap((record) =>
        record.record.participants.flatMap((p) =>
          p.kind === "human" && p.accountId ? [p.accountId] : [],
        ),
      ),
    ),
  ];
  const avatars = new Map<string, string | null>();
  if (accountIds.length) {
    const profiles = await db
      .prepare(
        `SELECT id, avatarKey FROM user WHERE id IN (${accountIds.map(() => "?").join(",")})`,
      )
      .bind(...accountIds)
      .all<{ id: string; avatarKey: string | null }>();
    for (const profile of profiles.results)
      avatars.set(profile.id, profileAvatarUrl(profile.avatarKey));
  }
  return avatars;
}
