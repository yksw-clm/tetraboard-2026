import type { DecodedMatch } from "./matchDataContracts";
import { profileAvatarUrl } from "./auth";

export type ParticipantProfile = { name: string; avatarUrl: string | null };
export type ParticipantProfiles = ReadonlyMap<string, ParticipantProfile>;

export async function participantProfiles(db: D1Database, records: DecodedMatch[]) {
  const accountIds = [
    ...new Set(
      records.flatMap((record) =>
        record.record.participants.flatMap((p) =>
          p.kind === "human" && p.accountId ? [p.accountId] : [],
        ),
      ),
    ),
  ];
  const profiles = new Map<string, ParticipantProfile>();
  if (accountIds.length) {
    const rows = await db
      .prepare(
        `SELECT id, name, avatarKey FROM user WHERE id IN (${accountIds.map(() => "?").join(",")})`,
      )
      .bind(...accountIds)
      .all<{ id: string; name: string; avatarKey: string | null }>();
    for (const profile of rows.results)
      profiles.set(profile.id, {
        name: profile.name,
        avatarUrl: profileAvatarUrl(profile.avatarKey),
      });
  }
  return profiles;
}
