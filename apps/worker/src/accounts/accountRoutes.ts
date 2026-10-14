import { reserveAvatarUpload, finishAvatarUpload } from "../privacy/avatarUploads";
import { isDeleted } from "../privacy/identity";
import { completeLegalAuthentication } from "../privacy/oauthConsent";
import { completeReauthentication } from "../privacy/deletion";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { consentStatement } from "../privacy/consent";
import {
  completeRegistrationOAuth,
  prepareRegistrationOAuth,
  rememberRegistrationOAuth,
  validateRegistrationSetup,
  RegistrationError,
  type RegistrationFlow,
} from "./registrationFlows";
import { Hono } from "hono";
import { accountSessionSchema, profileInputSchema } from "@tetraboard/protocol";
import {
  accountIdentity,
  avatarKeyPattern,
  createAuth,
  publicProfile,
  type AuthEnv,
  type StoredProfile,
} from "./auth";

export const accountRoutes = new Hono<{ Bindings: AuthEnv; Variables: { user: StoredProfile } }>();
const error = (message: string) => ({ message });
accountRoutes.use("*", async (c, next) => {
  if (/\/(auth|account)(\/|$)/.test(new URL(c.req.url).pathname))
    c.header("Cache-Control", "no-store");
  await next();
});
accountRoutes.onError((err, c) => {
  if (err instanceof RegistrationError)
    return c.json({ error: err.code, message: err.message }, err.status);
  console.error("Account request failed", err.name);
  return c.json(error("処理できませんでした。時間をおいてもう一度お試しください。"), 503);
});
accountRoutes.on(["GET", "POST"], "/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname.replace(/^\/api/, "");
  if (
    c.req.method === "GET" &&
    ["/auth/callback/google", "/auth/callback/discord"].includes(path)
  ) {
    const response = await createAuth(c.env).handler(
      new Request(`${c.env.APP_ORIGIN}/api${path}${new URL(c.req.url).search}`, c.req.raw),
    );
    await completeReauthentication(c.req.raw, response, c.env);
    await completeLegalAuthentication(c.req.raw, response, c.env);
    await completeRegistrationOAuth(c.req.raw, response, c.env);
    return response;
  }
  if (c.req.method !== "POST" || !["/auth/sign-in/social", "/auth/sign-out"].includes(path))
    return c.json(error("見つかりません。"), 404);
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json(error("操作元を確認できません。ページを開き直してください。"), 403);
  let provider: "google" | "discord" = "google";
  let adminLogin = false;
  let registration: RegistrationFlow | undefined;
  if (path === "/auth/sign-in/social") {
    let input: unknown;
    try {
      const body = await c.req.text();
      input = body ? JSON.parse(body) : {};
    } catch {
      return c.json(error("認証方法の指定が正しくありません。"), 400);
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      return c.json(error("認証方法の指定が正しくありません。"), 400);
    const data = input as Record<string, unknown>;
    if (data.provider !== undefined && data.provider !== "google" && data.provider !== "discord")
      return c.json(error("認証方法の指定が正しくありません。"), 400);
    provider = data.provider === "discord" ? "discord" : "google";
    if (
      data.destination !== "admin" &&
      data.consentVersion !== legalVersion &&
      c.req.header("X-Legal-Consent") !== legalVersion
    )
      return c.json(error("規約と年齢条件を確認してください。"), 403);
    adminLogin = data.destination === "admin";
    if (data.registration !== undefined) {
      if (adminLogin) return c.json(error("管理画面のログインでは対局を引き継げません。"), 400);
      registration = await prepareRegistrationOAuth(c.env, data.registration);
    }
    if (adminLogin && provider !== "google")
      return c.json(error("管理画面にはGoogleでログインしてください。"), 400);
    const configured =
      provider === "google"
        ? c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET
        : c.env.DISCORD_CLIENT_ID && c.env.DISCORD_CLIENT_SECRET;
    if (!configured)
      return c.json(
        error(`${provider === "google" ? "Google" : "Discord"}ログインは準備中です。`),
        503,
      );
  }
  // 許可したプロバイダーだけを使い、遷移先はサーバーで固定します。
  const response = await createAuth(c.env).handler(
    new Request(`${c.env.APP_ORIGIN}/api${path}`, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(
        path === "/auth/sign-out"
          ? {}
          : {
              provider,
              callbackURL: adminLogin ? "/admin" : "/account",
              newUserCallbackURL: adminLogin ? "/admin" : "/account/setup",
              errorCallbackURL: adminLogin ? "/login?destination=admin" : "/login",
            },
      ),
    }),
  );
  if (path === "/auth/sign-in/social" && !adminLogin && response.ok) {
    const data = (await response.clone().json()) as { url?: string };
    const state = data.url ? new URL(data.url).searchParams.get("state") : null;
    if (state) {
      await c.env.APP_DB.prepare("INSERT INTO oauth_legal_consents VALUES (?,?,?,?,?)")
        .bind(state, provider, legalVersion, Date.now(), Date.now() + 600000)
        .run();
      if (registration) await rememberRegistrationOAuth(c.env, registration, state, provider);
    }
  }
  return response;
});
accountRoutes.get("/account/session", async (c) => {
  const user = await accountIdentity(c.req.raw, c.env);
  return c.json(accountSessionSchema.parse({ user: user ? publicProfile(user) : null }));
});
accountRoutes.get("/avatars/:id", async (c) => {
  const key = `avatars/${c.req.param("id")}.webp`;
  if (!avatarKeyPattern.test(key)) return c.notFound();
  const blocked = await c.env.APP_DB.prepare(
    "SELECT 1 FROM deleted_accounts WHERE avatar_key=? UNION ALL SELECT 1 FROM deletion_images WHERE key=? LIMIT 1",
  )
    .bind(key, key)
    .first();
  if (blocked) return c.notFound();
  const object = await c.env.OBJECT_STORAGE.get(key);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=3600",
      ETag: object.httpEtag,
    },
  });
});
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

// Content-Lengthのないリクエストも、読み取り時点で上限を適用します。
async function readLimitedBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
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
  const registration =
    action === "setup" ? await validateRegistrationSetup(c.req.raw, c.env) : undefined;
  const expectedCompleted = action === "setup" ? 0 : 1;
  if (Number(Boolean(user.profileCompleted)) !== expectedCompleted)
    return c.json(error("設定状態が変わりました。ページを開き直してください。"), 409);
  const bytes = await readLimitedBody(c.req.raw, 1024 * 1024 + 8192);
  if (!bytes) return c.json(error("画像は変換後1MB以下にしてください。"), 413);
  let data: FormData;
  try {
    if (!c.req.header("Content-Type")?.startsWith("multipart/form-data;")) throw new Error();
    data = await new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: bytes,
    }).formData();
  } catch {
    return c.json(error("入力内容を読み取れませんでした。"), 400);
  }
  if (action === "setup" && data.get("consentVersion") !== legalVersion)
    return c.json(error("規約と年齢条件を確認してください。"), 403);
  const input = profileInputSchema.safeParse({
    name: data.get("name"),
    username: data.get("username"),
  });
  if (!input.success)
    return c.json(error("名前は1〜10文字、IDは半角英数字と_の3〜20文字にしてください。"), 400);
  const avatarAction = data.get("avatarAction");
  if (!["keep", "replace", "remove"].includes(String(avatarAction)))
    return c.json(error("アイコンの指定が正しくありません。"), 400);
  let avatarKey = user.avatarKey;
  let image = publicProfile(user).avatarUrl;
  let uploadedKey: string | null = null;
  if (avatarAction === "replace") {
    const file = data.get("avatar");
    if (!(file instanceof File) || file.size > 1024 * 1024 || file.type !== "image/webp")
      return c.json(error("アイコンは1MB以下のWebP画像にしてください。"), 400);
    const avatarBytes = new Uint8Array(await file.arrayBuffer());
    if (!validAvatar(avatarBytes))
      return c.json(error("256pxの正方形WebP画像に変換できませんでした。"), 400);
    const id = crypto.randomUUID();
    uploadedKey = avatarKey = `avatars/${id}.webp`;
    image = `/api/avatars/${id}`;
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
  } else if (avatarAction === "remove") {
    avatarKey = null;
    image = null;
  }
  let publicProfileId = user.publicProfileId ?? crypto.randomUUID();
  let changed = false;
  try {
    // 同時編集で参照中の画像を消さず、旧画像の削除待ちをプロフィールと同時に保存します。
    const results = await c.env.APP_DB.batch<{ id: string; publicProfileId: string }>([
      c.env.APP_DB.prepare(`UPDATE user SET name = ?, username = ?, profileCompleted = 1, image = ?, avatarKey = ?, updatedAt = ?, publicProfileId = COALESCE(publicProfileId, ?)
        WHERE id = ? AND COALESCE(profileCompleted, 0) = ? AND avatarKey IS ? AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=user.id)
        ${
          registration
            ? `AND EXISTS (SELECT 1 FROM registration_flows f JOIN session s ON s.id=f.session_id AND s.userId=f.account_id
          WHERE f.id=? AND f.account_id=user.id AND f.session_id=? AND f.cancelled_at_ms IS NULL AND f.claim_until_ms>? AND s.expiresAt>?)`
            : ""
        }
        RETURNING id, publicProfileId`).bind(
        input.data.name,
        input.data.username,
        image,
        avatarKey,
        Date.now(),
        publicProfileId,
        user.id,
        expectedCompleted,
        user.avatarKey,
        ...(registration ? [registration.id, registration.session_id, Date.now(), Date.now()] : []),
      ),
      c.env.APP_DB.prepare(
        "INSERT OR IGNORE INTO avatar_deletions (key) SELECT ? WHERE ? IS NOT NULL AND ? IS NOT ? AND changes() = 1",
      ).bind(user.avatarKey, user.avatarKey, user.avatarKey, avatarKey),
      ...(data.get("consentVersion") === legalVersion
        ? [consentStatement(c.env.APP_DB, user.id)]
        : []),
      ...(uploadedKey
        ? [
            c.env.APP_DB.prepare(
              "DELETE FROM avatar_deletions WHERE key=? AND EXISTS(SELECT 1 FROM user WHERE id=? AND avatarKey=?)",
            ).bind(uploadedKey, user.id, uploadedKey),
          ]
        : []),
    ]);
    changed = results[0].results.length === 1;
    if (changed) publicProfileId = String(results[0].results[0]!.publicProfileId);
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
  if (!changed) {
    if (uploadedKey) await c.env.OBJECT_STORAGE.delete(uploadedKey);
    if (await isDeleted(c.env.APP_DB, user.id))
      return c.json(error("アカウントは削除されました。"), 401);
    if (registration) await validateRegistrationSetup(c.req.raw, c.env);
    return c.json(error("設定が更新されています。ページを開き直してください。"), 409);
  }
  c.executionCtx.waitUntil(deleteUnusedAvatars(c.env));
  return c.json(
    publicProfile({
      ...user,
      ...input.data,
      profileCompleted: 1,
      image,
      avatarKey,
      publicProfileId,
    }),
  );
});
export async function deleteUnusedAvatars(env: Env) {
  const rows = await env.APP_DB.prepare("SELECT key FROM avatar_deletions LIMIT 100").all<{
    key: string;
  }>();
  for (const { key } of rows.results) {
    if (!avatarKeyPattern.test(key)) continue;
    if (
      await env.APP_DB.prepare(
        "SELECT id FROM user WHERE avatarKey = ? UNION ALL SELECT operation_id AS id FROM room_avatar_refs WHERE avatar_key = ? LIMIT 1",
      )
        .bind(key, key)
        .first()
    )
      continue;
    try {
      await env.OBJECT_STORAGE.delete(key);
      await env.APP_DB.prepare("DELETE FROM avatar_deletions WHERE key = ?").bind(key).run();
    } catch {
      console.error("Avatar deletion will be retried");
    }
  }
}

export function validAvatar(bytes: Uint8Array): boolean {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length < 30 || text(0, 4) !== "RIFF" || text(8, 12) !== "WEBP") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return false;
  let valid = false;
  for (let at = 12; at + 8 <= bytes.length;) {
    const type = text(at, at + 4);
    const size = view.getUint32(at + 4, true);
    const data = at + 8;
    if (data + size > bytes.length) return false;
    if (type === "ANIM" || type === "ANMF") return false;
    if (type === "VP8 " && size >= 10)
      valid =
        text(data + 3, data + 6) === "\x9d\x01\x2a" &&
        (view.getUint16(data + 6, true) & 0x3fff) === 256 &&
        (view.getUint16(data + 8, true) & 0x3fff) === 256;
    if (type === "VP8L" && size >= 5) {
      const bits = view.getUint32(data + 1, true);
      valid =
        bytes[data] === 0x2f && (bits & 0x3fff) + 1 === 256 && ((bits >>> 14) & 0x3fff) + 1 === 256;
    }
    at = data + size + (size % 2);
  }
  return valid;
}
