import type { ProfileDetails } from "./profileDetails";
export type CurrentProfile = {
  name: string;
  username: string | null;
  avatarUrl: string | null;
  publicProfileId: string | null;
  profileCompleted: number;
  isAnonymous: number | null;
  profileMessage: string;
  favoriteGames: ProfileDetails["favoriteGames"];
};
export type CurrentProfileRow = Omit<CurrentProfile, "avatarUrl" | "favoriteGames"> & {
  id: string;
  avatarKey: string | null;
  avatarPresetId: string | null;
  favoriteGames: string;
};
