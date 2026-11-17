import { isAvatarPresetId } from "@tetraboard/protocol";
import { selectProfileAvatar, type StoredProfile } from "@tetraboard/context-account";
import { profilePolicy } from "../adapters/account/profilePolicy";
import { reserveAvatarUpload, finishAvatarUpload } from "../privacy/avatarUploads";
import { validAvatar } from "./accountAvatars";
import type { AccountRouteContext } from "./accountRoutes";
const error = (message: string) => ({ message });
export async function prepareProfileAvatar(
  c: AccountRouteContext,
  user: StoredProfile,
  data: FormData,
) {
  const avatarAction = data.get("avatarAction");
  if (data.has("avatarPresetId") && !isAvatarPresetId(data.get("avatarPresetId")))
    return c.json(error("アイコンの指定が正しくありません。"), 400);
  if (!["keep", "replace", "remove", "preset"].includes(String(avatarAction)))
    return c.json(error("アイコンの指定が正しくありません。"), 400);
  const selected = data.get("avatarPresetId");
  if (avatarAction === "preset" && !isAvatarPresetId(selected))
    return c.json(error("アイコンの指定が正しくありません。"), 400);
  let { avatarKey, image, avatarPresetId } = selectProfileAvatar(
    user,
    String(avatarAction),
    typeof selected === "string" ? selected : null,
    profilePolicy,
  );
  let uploadedKey: string | null = null;
  if (avatarAction === "replace") {
    const uploaded = await uploadAvatar(c, user, data);
    if (uploaded instanceof Response) return uploaded;
    uploadedKey = avatarKey = uploaded.avatarKey;
    image = uploaded.image;
  }
  return { avatarKey, image, uploadedKey, avatarPresetId };
}
async function uploadAvatar(c: AccountRouteContext, user: StoredProfile, data: FormData) {
  const file = data.get("avatar");
  if (!(file instanceof File) || file.size > 1024 * 1024 || file.type !== "image/webp")
    return c.json(error("アイコンは1MB以下のWebP画像にしてください。"), 400);
  const avatarBytes = new Uint8Array(await file.arrayBuffer());
  if (!validAvatar(avatarBytes))
    return c.json(error("256pxの正方形WebP画像に変換できませんでした。"), 400);
  let id = crypto.randomUUID();
  while (isAvatarPresetId(id)) id = crypto.randomUUID();
  const avatarKey = `avatars/${id}.webp`;
  const image = `/api/avatars/${id}`;
  if (!(await reserveAvatarUpload(c.env, user.id, avatarKey)))
    return c.json(error("ログイン状態を確認してください。"), 401);
  try {
    await c.env.OBJECT_STORAGE.put(avatarKey, avatarBytes, {
      httpMetadata: { contentType: "image/webp" },
    });
  } catch (e) {
    await finishAvatarUpload(c.env, user.id, avatarKey);
    throw e;
  }
  return { avatarKey, image };
}
