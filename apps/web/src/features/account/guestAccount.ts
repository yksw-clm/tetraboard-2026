import {
  accountProfileSchema,
  profileInputSchema,
  type AccountProfile,
  type AvatarPresetId,
} from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountRequest, readAccount } from "./accountApi";

export const guestStorageNotice =
  "ゲストの名前と記録はこのブラウザで使えます。Cookieを削除すると復旧できません。Google・Discordに連携すると別端末でも使えます。";
let pending: Promise<AccountProfile> | null = null;
export async function ensureGuestAccount(
  name: string,
  user: AccountProfile | null,
  avatarPresetId?: AvatarPresetId,
): Promise<AccountProfile> {
  if (user && (!user.isGuest || user.nameCustomized)) return user;
  const parsed = profileInputSchema.shape.name.safeParse(name);
  if (!parsed.success) throw new Error("ニックネームを1〜10文字で入力してください。");
  if (pending) return pending;
  const create = async () => {
    const current = await readAccount(AbortSignal.timeout(10000));
    if (current && (!current.isGuest || current.nameCustomized)) return current;
    const result = accountProfileSchema.parse(
      await accountRequest("/api/account/guest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Legal-Consent": legalVersion },
        body: JSON.stringify({ name: parsed.data, avatarPresetId }),
        signal: AbortSignal.timeout(10000),
      }),
    );
    const confirmed = await readAccount(AbortSignal.timeout(10000));
    if (!confirmed || confirmed.profileId !== result.profileId)
      throw new Error("ゲストの認証情報を保存できません。Cookieの設定を確認してください。");
    return confirmed;
  };
  // 別タブから同時に初参加しても、同じブラウザでは先に作成したゲストを使います。
  pending = (
    navigator.locks ? navigator.locks.request("tetraboard:guest-account", create) : create()
  ).finally(() => {
    pending = null;
  });
  return pending;
}

export const guestIdentityChangedMessage =
  "別の操作でプロフィールが設定されました。表示された名前とアイコンを確認して、もう一度進んでください。";

export async function prepareRoomGuest(
  name: string,
  user: AccountProfile | null,
  avatarPresetId: AvatarPresetId | undefined,
  update: (user: AccountProfile) => void,
): Promise<AccountProfile> {
  const profile = await ensureGuestAccount(name, user, avatarPresetId);
  update(profile);
  if (
    avatarPresetId !== undefined &&
    (!profile.isGuest || profile.name !== name.trim() || profile.avatarPresetId !== avatarPresetId)
  )
    throw new Error(guestIdentityChangedMessage);
  return profile;
}
