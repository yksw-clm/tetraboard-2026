import type { AccountProfile, AvatarPresetId } from "@tetraboard/protocol";
import { readProfileDetails, type ProfileDetailsParser } from "./profileDetails";

export interface AvatarPolicy {
  accountAvatarPresetId(id: string, presetId?: string | null): AvatarPresetId;
  isAvatarPresetId(value: unknown): value is AvatarPresetId;
  avatarPresetUrl(id: AvatarPresetId): string;
}
export interface ProfilePolicy extends AvatarPolicy {
  parseDetails: ProfileDetailsParser;
}

export type StoredProfile = {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
  profileCompleted: number;
  avatarKey: string | null;
  avatarPresetId?: string | null;
  profileMessage?: string;
  favoriteGames?: string;
  isTestUser?: number | null;
  publicProfileId?: string | null;
  isAnonymous?: number | null;
  guestNameCustomized?: number | null;
};
export function publicProfile(user: StoredProfile, policy: ProfilePolicy): AccountProfile {
  return {
    profileId: user.publicProfileId ?? null,
    name: user.name,
    username: user.username,
    avatarUrl: accountAvatarUrl(user, policy),
    avatarPresetId: policy.accountAvatarPresetId(user.id, user.avatarPresetId),
    profileCompleted: Boolean(user.profileCompleted),
    ...(!user.isAnonymous ? readProfileDetails(user, policy.parseDetails) : {}),
    ...(user.isAnonymous
      ? { isGuest: true, nameCustomized: Boolean(user.guestNameCustomized) }
      : {}),
  };
}

export const avatarKeyPattern =
  /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
export function profileAvatarUrl(
  key: string | null,
  presetId: string | null | undefined,
  policy: AvatarPolicy,
): string | null {
  return key && avatarKeyPattern.test(key)
    ? `/api/avatars/${key.slice(8, -5)}`
    : policy.isAvatarPresetId(presetId)
      ? policy.avatarPresetUrl(presetId)
      : null;
}
export function accountAvatarUrl(
  user: {
    id: string;
    avatarKey: string | null;
    avatarPresetId?: string | null;
  },
  policy: AvatarPolicy,
): string {
  return profileAvatarUrl(
    user.avatarKey,
    policy.accountAvatarPresetId(user.id, user.avatarPresetId),
    policy,
  )!;
}

export function selectProfileAvatar(
  user: StoredProfile,
  action: string,
  presetId: string | null,
  policy: ProfilePolicy,
) {
  let avatarKey = user.avatarKey;
  let image = user.avatarKey ? publicProfile(user, policy).avatarUrl : null;
  const avatarPresetId = action === "preset" ? presetId : (user.avatarPresetId ?? null);
  if (action === "remove" || action === "preset") {
    avatarKey = null;
    image = null;
  }
  return { avatarKey, image, avatarPresetId };
}
