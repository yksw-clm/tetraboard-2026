import type { AvatarPresetId } from "@tetraboard/protocol";
import type { StoredProfile } from "../domain/profile";
import { createGuestUsername, isGuestUsernameCollision } from "../domain/guestUsernames";
export const guestLifetimeMs = 180 * 86400000;
export type GuestCreation = {
  user: StoredProfile;
  now: number;
  hash: string | null;
  username: string;
};
export type GuestNameChange = {
  user: StoredProfile;
  name: string;
  avatarPresetId: string | null | undefined;
  updatedAt: string;
};
export interface GuestAccountStore {
  create(command: GuestCreation): Promise<void>;
  customize(command: GuestNameChange): Promise<unknown>;
  rename(command: GuestNameChange): Promise<unknown>;
  rate(key: string, now: number): Promise<{ count: number } | null>;
  clear(hash: string): Promise<void>;
  suspend(hash: string, now: number): Promise<void>;
}
export interface GuestRuntime {
  now(): number;
  id(): string;
  number(): number;
  credential(): Promise<{ token: string; hash: string | null }>;
  issueSession(token: string): void;
}
export async function createGuestAccount(
  store: GuestAccountStore,
  runtime: GuestRuntime,
  name?: string,
  avatarPresetId?: AvatarPresetId,
): Promise<StoredProfile> {
  const now = runtime.now(),
    id = runtime.id();
  const number = String(runtime.number() % 100000).padStart(5, "0");
  const user: StoredProfile = {
    id,
    name: name ?? `ゲスト${number}`,
    username: null,
    image: null,
    avatarKey: null,
    avatarPresetId: avatarPresetId ?? null,
    profileCompleted: 1,
    isAnonymous: 1,
    guestNameCustomized: name ? 1 : 0,
    publicProfileId: runtime.id(),
  };
  const { token, hash } = await runtime.credential();
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = createGuestUsername(runtime.id());
    try {
      await store.create({ user, now, hash, username });
      user.username = username;
      runtime.issueSession(token);
      return user;
    } catch (error) {
      if (!isGuestUsernameCollision(error)) throw error;
    }
  }
  throw new Error("Guest username allocation failed");
}
export async function changeGuestName(
  store: GuestAccountStore,
  command: GuestNameChange,
  initial = false,
) {
  const changed = await (initial ? store.customize(command) : store.rename(command));
  return changed
    ? {
        ...command.user,
        name: command.name,
        avatarPresetId: command.avatarPresetId,
        guestNameCustomized: 1,
      }
    : null;
}
export async function allowGuestCreation(store: GuestAccountStore, key: string, now: number) {
  const rate = await store.rate(key, now);
  return !rate || rate.count <= 20;
}
