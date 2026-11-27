import type { ProfileSave, SavedProfile } from "./saveProfile";
import type { CurrentProfileRow } from "../domain/currentProfiles";
import type { StoredProfile } from "../domain/profile";
export interface AccountProfiles {
  sessionProfile(id: string): Promise<StoredProfile | null>;
  currentProfiles(ids: readonly string[]): Promise<CurrentProfileRow[]>;
  accountId(profileId: string): Promise<string | null>;
  accountIdByUsername(username: string): Promise<string | null>;
  mergedAccountId(guestId: string): Promise<string | null>;
}
export interface ProfileWriter {
  save(command: ProfileSave): Promise<SavedProfile | null>;
}
