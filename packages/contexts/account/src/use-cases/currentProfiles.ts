import { accountAvatarUrl, type ProfilePolicy } from "../domain/profile";
import { readProfileDetails } from "../domain/profileDetails";
import type { CurrentProfile } from "../domain/currentProfiles";
import type { AccountProfiles } from "./ports";
export async function readCurrentProfiles(
  profiles: AccountProfiles,
  policy: ProfilePolicy,
  ids: readonly string[],
): Promise<ReadonlyMap<string, CurrentProfile>> {
  const unique = [...new Set(ids)];
  const result = new Map<string, CurrentProfile>();
  if (!unique.length) return result;
  const rows = await profiles.currentProfiles(unique);
  for (const { id, avatarKey, avatarPresetId, ...row } of rows) {
    result.set(id, {
      ...row,
      ...readProfileDetails(row, policy.parseDetails),
      avatarUrl: accountAvatarUrl({ id, avatarKey, avatarPresetId }, policy),
    });
  }
  return result;
}
