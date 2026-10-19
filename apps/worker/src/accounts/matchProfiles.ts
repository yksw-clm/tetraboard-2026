import { resolveMatchParticipantList } from "./matchClaims";
import type { DecodedMatch } from "./matchDataContracts";
import { readCurrentProfiles } from "./currentProfiles";

export type ParticipantProfile = { name: string; avatarUrl: string | null };
export type ParticipantProfiles = ReadonlyMap<string, ParticipantProfile>;

export async function participantProfiles(db: D1Database, records: DecodedMatch[]) {
  await resolveMatchParticipantList(db, records);
  const accountIds = [
    ...new Set(
      records.flatMap((record) =>
        record.record.participants.flatMap((p) =>
          p.kind === "human" && p.accountId ? [p.accountId] : [],
        ),
      ),
    ),
  ];
  const current = await readCurrentProfiles(db, accountIds);
  const profiles = new Map<string, ParticipantProfile>();
  for (const [id, profile] of current)
    profiles.set(id, { name: profile.name, avatarUrl: profile.avatarUrl });
  return profiles;
}
