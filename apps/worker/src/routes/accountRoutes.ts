import { Hono, type Context } from "hono";
import { accountSessionSchema } from "@tetraboard/protocol";
import { GuestLinkError, saveProfile } from "@tetraboard/context-account";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { writeProfileCompletionUsage } from "../usageEvents/registration";
import { finishAvatarUpload } from "../privacy/avatarUploads";
import { isDeleted } from "../privacy/identity";
import {
  validateRegistrationSetup,
  RegistrationError,
  type RegistrationFlow,
} from "../flows/guestRegistration/account";
import { accountIdentity, publicProfile, type AuthEnv, type StoredProfile } from "../accounts/auth";
import { D1ProfileWriter } from "../adapters/account/profileWrites";
import { avatarRoutes, deleteUnusedAvatars } from "./accountAvatars";
import { accountAuthRoutes } from "./accountAuthRoutes";
import { readProfileForm, parseProfileForm } from "./accountProfileInput";
import { prepareProfileAvatar } from "./accountProfileAvatar";
export type AccountRouteContext = Context<{
  Bindings: AuthEnv;
  Variables: { user: StoredProfile };
}>;
export const accountRoutes = new Hono<{ Bindings: AuthEnv; Variables: { user: StoredProfile } }>();
const error = (message: string) => ({ message });
accountRoutes.use("*", async (c, next) => {
  if (/\/(auth|account)(\/|$)/.test(new URL(c.req.url).pathname))
    c.header("Cache-Control", "no-store");
  await next();
});
accountRoutes.onError((err, c) => {
  if (err instanceof GuestLinkError) return c.json(error(err.message), 409);
  if (err instanceof RegistrationError)
    return c.json({ error: err.code, message: err.message }, err.status);
  console.error("Account request failed", err.name);
  return c.json(error("処理できませんでした。時間をおいてもう一度お試しください。"), 503);
});
accountRoutes.get("/account/session", async (c) => {
  const user = await accountIdentity(c.req.raw, c.env);
  return c.json(accountSessionSchema.parse({ user: user ? publicProfile(user) : null }));
});
accountRoutes.route("/", avatarRoutes);
accountRoutes.route("/", accountAuthRoutes);
accountRoutes.use("/account/*", async (c, next) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json(error("操作元を確認できません。ページを開き直してください。"), 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.json(error("ログインしてください。"), 401);
  c.set("user", user);
  const now = Date.now();
  const key = `profile:${user.id}`;
  const row =
    await c.env.APP_DB.prepare(`INSERT INTO rateLimit (id, key, count, lastRequest) VALUES (?, ?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN lastRequest < ? THEN 1 ELSE count + 1 END,
    lastRequest = CASE WHEN lastRequest < ? THEN excluded.lastRequest ELSE lastRequest END RETURNING count`)
      .bind(key, key, now, now - 60_000, now - 60_000)
      .first<{ count: number }>();
  if (row && row.count > 20) return c.json(error("変更が多すぎます。1分ほど待ってください。"), 429);
  await next();
});

accountRoutes.on(["POST", "PATCH"], "/account/:action", async (c) => {
  const action = c.req.param("action");
  if (
    !(
      (action === "setup" && c.req.method === "POST") ||
      (action === "profile" && c.req.method === "PATCH")
    )
  )
    return c.notFound();
  const user = c.get("user");
  if (user.isAnonymous) return c.json(error("ゲストは名前の変更画面を利用してください。"), 403);
  const registration =
    action === "setup" ? await validateRegistrationSetup(c.req.raw, c.env) : undefined;
  const expectedCompleted = action === "setup" ? 0 : 1;
  if (Number(Boolean(user.profileCompleted)) !== expectedCompleted)
    return c.json(error("設定状態が変わりました。ページを開き直してください。"), 409);
  const data = await readProfileForm(c, action);
  if (data instanceof Response) return data;
  const parsed = parseProfileForm(c, data);
  if (parsed instanceof Response) return parsed;
  const avatar = await prepareProfileAvatar(c, user, data);
  if (avatar instanceof Response) return avatar;
  return persistProfile(c, action, user, registration, expectedCompleted, data, parsed, avatar);
});
async function persistProfile(
  c: AccountRouteContext,
  action: string,
  user: StoredProfile,
  registration: RegistrationFlow | undefined,
  expectedCompleted: number,
  data: FormData,
  parsed: Exclude<ReturnType<typeof parseProfileForm>, Response>,
  avatar: Exclude<Awaited<ReturnType<typeof prepareProfileAvatar>>, Response>,
) {
  const { uploadedKey } = avatar;
  const publicProfileId = user.publicProfileId ?? crypto.randomUUID();
  let saved: StoredProfile | null;
  try {
    saved = await saveProfile(new D1ProfileWriter(c.env.APP_DB), {
      user,
      input: parsed.input,
      details: parsed.details,
      ...avatar,
      publicProfileId,
      expectedCompleted,
      registration: registration
        ? { id: registration.id, session_id: registration.session_id }
        : undefined,
      consent: data.get("consentVersion") === legalVersion,
      uploadedKey,
      now: Date.now(),
    });
  } catch (err) {
    if (uploadedKey) {
      await finishAvatarUpload(c.env, user.id, uploadedKey);
      await c.env.OBJECT_STORAGE.delete(uploadedKey);
    }
    if (err instanceof Error && /unique/i.test(err.message))
      return c.json(error("このIDはすでに使われています。"), 409);
    throw err;
  }
  if (uploadedKey) await finishAvatarUpload(c.env, user.id, uploadedKey);
  if (!saved) {
    if (uploadedKey) await c.env.OBJECT_STORAGE.delete(uploadedKey);
    if (await isDeleted(c.env.APP_DB, user.id))
      return c.json(error("アカウントは削除されました。"), 401);
    if (registration) await validateRegistrationSetup(c.req.raw, c.env);
    return c.json(error("設定が更新されています。ページを開き直してください。"), 409);
  }
  if (action === "setup" && !user.profileCompleted)
    await writeProfileCompletionUsage(c.env, user.id, c.req.raw);
  c.executionCtx.waitUntil(deleteUnusedAvatars(c.env));
  return c.json(publicProfile(saved));
}
