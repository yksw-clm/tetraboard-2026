import type { ProfileWriter } from "./ports";
import type { StoredProfile } from "../domain/profile";
import type { ProfileDetails } from "../domain/profileDetails";
export type SavedProfile = {
  id: string;
  publicProfileId: string;
  profileMessage: string;
  favoriteGames: string;
};
export type ProfileSave = {
  user: StoredProfile;
  input: { name: string; username: string };
  details: Partial<ProfileDetails>;
  image: string | null;
  avatarKey: string | null;
  avatarPresetId: string | null;
  publicProfileId: string;
  expectedCompleted: number;
  registration?: { id: string; session_id: string | null };
  consent: boolean;
  uploadedKey: string | null;
  now: number;
};
export async function saveProfile(writer: ProfileWriter, command: ProfileSave) {
  const row = await writer.save(command);
  if (!row) return null;
  return {
    ...command.user,
    ...command.input,
    profileMessage: row.profileMessage,
    favoriteGames: row.favoriteGames,
    profileCompleted: 1,
    image: command.image,
    avatarKey: command.avatarKey,
    avatarPresetId: command.avatarPresetId,
    publicProfileId: row.publicProfileId,
  };
}
