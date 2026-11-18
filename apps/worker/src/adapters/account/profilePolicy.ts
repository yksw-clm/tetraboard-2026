import {
  publicProfile as toPublicProfile,
  accountAvatarUrl as toAccountAvatarUrl,
  profileAvatarUrl as toProfileAvatarUrl,
  type StoredProfile,
  type ProfilePolicy,
} from "@tetraboard/context-account";
import {
  accountAvatarPresetId,
  avatarPresetUrl,
  isAvatarPresetId,
  profileDetailsSchema,
} from "@tetraboard/protocol";
export { avatarKeyPattern } from "@tetraboard/context-account";
export const profilePolicy: ProfilePolicy = {
  accountAvatarPresetId,
  avatarPresetUrl,
  isAvatarPresetId,
  parseDetails: (input) => profileDetailsSchema.parse(input),
};
export const publicProfile = (user: StoredProfile) => toPublicProfile(user, profilePolicy);
export const accountAvatarUrl = (user: Parameters<typeof toAccountAvatarUrl>[0]) =>
  toAccountAvatarUrl(user, profilePolicy);
export const profileAvatarUrl = (key: string | null, presetId?: string | null) =>
  toProfileAvatarUrl(key, presetId, profilePolicy);
