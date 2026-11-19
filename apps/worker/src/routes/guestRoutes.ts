import { Hono } from "hono";
import { profileInputSchema, isAvatarPresetId } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { changeGuestName, allowGuestCreation } from "@tetraboard/context-account";
import { D1GuestAccounts } from "../adapters/account/guestAccounts";
import { authSecret } from "../adapters/account/authTokens";
import { readLimitedBody } from "./readLimitedBody";
import { accountIdentity, publicProfile } from "../accounts/auth";
import { createGuestAccount } from "./guestSession";
async function guestInput(request: Request): Promise<{
  name?: unknown;
  avatarPresetId?: unknown;
  username?: unknown;
  avatarAction?: unknown;
  avatar?: unknown;
  profileMessage?: unknown;
  favoriteGames?: unknown;
} | null> {
  const bytes = await readLimitedBody(request, 4096);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
export const guestRoutes = new Hono<{ Bindings: Env }>();
guestRoutes.use("/account/guest*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
guestRoutes.onError(
  () =>
    new Response(
      JSON.stringify({ message: "ゲスト情報を保存できませんでした。再試行してください。" }),
      { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    ),
);
guestRoutes.post("/account/guest", async (c) => {
  if (
    c.req.header("Origin") !== c.env.APP_ORIGIN ||
    c.req.header("X-Legal-Consent") !== legalVersion
  )
    return c.json({ message: "規約と年齢条件を確認してください。" }, 403);
  const data = await guestInput(c.req.raw);
  if (data && ("profileMessage" in data || "favoriteGames" in data))
    return c.json(
      { message: "ひとこと・お気に入りゲームの設定にはGoogleまたはDiscordとの連携が必要です。" },
      403,
    );
  const name = profileInputSchema.shape.name.safeParse(data?.name);
  if (!name.success) return c.json({ message: "名前は1〜10文字で入力してください。" }, 400);
  if (data?.avatarPresetId !== undefined && !isAvatarPresetId(data.avatarPresetId))
    return c.json({ message: "アイコンの指定が正しくありません。" }, 400);
  if (
    data?.username !== undefined ||
    data?.avatarAction !== undefined ||
    data?.avatar !== undefined
  )
    return c.json(
      { message: "画像アップロードとID変更にはGoogleまたはDiscordとの連携が必要です。" },
      403,
    );
  const avatarPresetId = isAvatarPresetId(data?.avatarPresetId) ? data.avatarPresetId : undefined;
  const existing = await accountIdentity(c.req.raw, c.env);
  if (existing) {
    if (existing.isAnonymous && !existing.guestNameCustomized) {
      const changed = await changeGuestName(
        new D1GuestAccounts(c.env.APP_DB),
        {
          user: existing,
          name: name.data,
          avatarPresetId: avatarPresetId ?? existing.avatarPresetId,
          updatedAt: new Date().toISOString(),
        },
        true,
      );
      if (!changed)
        return c.json({ message: "設定状態が変わりました。ページを開き直してください。" }, 409);
      return c.json(publicProfile(changed));
    }
    return c.json(publicProfile(existing));
  }
  if (/(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(c.req.header("Cookie") ?? ""))
    return c.json({ message: "ログイン状態を確認してください。" }, 401);
  const key = await guestRateKey(c.req.raw, c.env),
    now = Date.now();
  if (!(await allowGuestCreation(new D1GuestAccounts(c.env.APP_DB), key, now)))
    return c.json({ message: "作成が多すぎます。1分ほど待ってください。" }, 429);
  return c.json(
    publicProfile(await createGuestAccount(c.req.raw, c.env, name.data, avatarPresetId)),
    201,
  );
});
guestRoutes.patch("/account/guest/name", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user?.isAnonymous) return c.json({ message: "ゲストとして参加してください。" }, 401);
  const data = await guestInput(c.req.raw);
  if (
    data?.username !== undefined ||
    data?.avatarAction !== undefined ||
    data?.avatar !== undefined ||
    data?.profileMessage !== undefined ||
    data?.favoriteGames !== undefined
  )
    return c.json(
      {
        message:
          "画像アップロード・ID変更・ひとこと・お気に入りゲームの設定にはGoogleまたはDiscordとの連携が必要です。",
      },
      403,
    );
  if (data?.avatarPresetId !== undefined && !isAvatarPresetId(data.avatarPresetId))
    return c.json({ message: "アイコンの指定が正しくありません。" }, 400);
  const avatarPresetId = isAvatarPresetId(data?.avatarPresetId)
    ? data.avatarPresetId
    : (user.avatarPresetId ?? null);
  const name = profileInputSchema.shape.name.safeParse(data?.name);
  if (!name.success) return c.json({ message: "名前は1〜10文字で入力してください。" }, 400);
  const changed = await changeGuestName(new D1GuestAccounts(c.env.APP_DB), {
    user,
    name: name.data,
    avatarPresetId,
    updatedAt: new Date().toISOString(),
  });
  if (!changed)
    return c.json({ message: "設定状態が変わりました。ページを開き直してください。" }, 409);
  return c.json(publicProfile(changed));
});

async function guestRateKey(request: Request, env: Env) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `guest-rate:${authSecret(env)}:${request.headers.get("CF-Connecting-IP") ?? "local"}`,
    ),
  );
  return `guest:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
