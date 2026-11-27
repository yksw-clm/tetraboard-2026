import type { AvatarPresetId, GameId } from "@tetraboard/protocol";
import type {
  AccountProfiles,
  CurrentProfileRow,
  ProfilePolicy,
  ProfileSave,
  ProfileWriter,
  StoredProfile,
} from "../src";
export const preset: AvatarPresetId = "a7e7ab0a-0001-4000-8000-000000000001";
export const uploadedId = "12345678-1234-4234-8234-123456789abc";
export const policy: ProfilePolicy = {
  accountAvatarPresetId: (_id, selected) => (selected === preset ? selected : preset),
  isAvatarPresetId: (id): id is AvatarPresetId => id === preset,
  avatarPresetUrl: (id) => `/api/avatars/${id}`,
  parseDetails: ({ profileMessage, favoriteGames }) => ({
    profileMessage,
    favoriteGames: favoriteGames as GameId[],
  }),
};
export const user: StoredProfile = {
  id: "account-1",
  name: "対局者",
  username: "player_1",
  image: null,
  avatarKey: null,
  avatarPresetId: null,
  profileCompleted: 1,
  publicProfileId: "11111111-1111-4111-8111-111111111111",
  profileMessage: "よろしく",
  favoriteGames: '["shogi","gomoku"]',
  isAnonymous: 0,
};
export const row: CurrentProfileRow = {
  id: user.id,
  name: user.name,
  username: user.username,
  avatarKey: null,
  avatarPresetId: null,
  profileCompleted: 1,
  publicProfileId: user.publicProfileId!,
  profileMessage: "よろしく",
  favoriteGames: '["shogi","gomoku"]',
  isAnonymous: 0,
};
export class MemoryProfiles implements AccountProfiles, ProfileWriter {
  rows = new Map([[row.id, { ...row }]]);
  users = new Map([[user.id, { ...user }]]);
  merges = new Map<string, string>();
  reads: readonly string[][] = [];
  commands: ProfileSave[] = [];
  async sessionProfile(id: string) {
    return this.users.get(id) ?? null;
  }
  async currentProfiles(ids: readonly string[]) {
    this.reads = [...this.reads, [...ids]];
    return ids.flatMap((id) => {
      const row = this.rows.get(id);
      return row ? [{ ...row }] : [];
    });
  }
  async accountId(profileId: string) {
    return [...this.rows.values()].find((r) => r.publicProfileId === profileId)?.id ?? null;
  }
  async accountIdByUsername(username: string) {
    return (
      [...this.rows.values()].find((r) => !r.isAnonymous && r.username?.toLowerCase() === username)
        ?.id ?? null
    );
  }
  async mergedAccountId(guestId: string) {
    return this.merges.get(guestId) ?? null;
  }
  async save(command: ProfileSave) {
    this.commands.push(command);
    const existing = this.users.get(command.user.id);
    if (
      !existing ||
      Number(Boolean(existing.profileCompleted)) !== command.expectedCompleted ||
      existing.avatarKey !== command.user.avatarKey ||
      (existing.avatarPresetId ?? null) !== (command.user.avatarPresetId ?? null)
    )
      return null;
    const changed = {
      ...existing,
      ...command.input,
      profileCompleted: 1,
      avatarKey: command.avatarKey,
      avatarPresetId: command.avatarPresetId,
      image: command.image,
      publicProfileId: existing.publicProfileId ?? command.publicProfileId,
      profileMessage: command.details.profileMessage ?? existing.profileMessage ?? "",
      favoriteGames:
        command.details.favoriteGames === undefined
          ? (existing.favoriteGames ?? "[]")
          : JSON.stringify(command.details.favoriteGames),
    };
    this.users.set(existing.id, changed);
    return {
      id: changed.id,
      publicProfileId: changed.publicProfileId,
      profileMessage: changed.profileMessage,
      favoriteGames: changed.favoriteGames,
    };
  }
}
export function saveCommand(overrides: Partial<ProfileSave> = {}): ProfileSave {
  return {
    user: { ...user },
    input: { name: "更新名", username: "updated_1" },
    details: {},
    image: null,
    avatarKey: null,
    avatarPresetId: preset,
    publicProfileId: "new-profile-id",
    expectedCompleted: 1,
    consent: false,
    uploadedKey: null,
    now: 1700000000000,
    ...overrides,
  };
}
