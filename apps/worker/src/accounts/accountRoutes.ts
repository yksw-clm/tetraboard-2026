import { Hono } from "hono";
import { accountSessionSchema, profileInputSchema } from "@tetraboard/protocol";
import {
  accountIdentity,
  createAuth,
  publicProfile,
  type AuthEnv,
  type StoredProfile,
} from "./auth";

export const accountRoutes = new Hono<{ Bindings: AuthEnv; Variables: { user: StoredProfile } }>();
const error = (message: string) => ({ message });
const avatarKeyPattern =
  /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
accountRoutes.use("*", async (c, next) => {
  if (/\/(auth|account)(\/|$)/.test(new URL(c.req.url).pathname))
    c.header("Cache-Control", "no-store");
  await next();
});
accountRoutes.onError((err, c) => {
  console.error("Account request failed", err.name);
  return c.json(error("処理できませんでした。時間をおいてもう一度お試しください。"), 503);
});
accountRoutes.on(["GET", "POST"], "/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname.replace(/^\/api/, "");
  if (c.req.method === "GET" && path === "/auth/callback/google")
    return createAuth(c.env).handler(
      new Request(
        `${c.env.APP_ORIGIN}/api/auth/callback/google${new URL(c.req.url).search}`,
        c.req.raw,
      ),
    );
  if (c.req.method !== "POST" || !["/auth/sign-in/social", "/auth/sign-out"].includes(path))
    return c.json(error("見つかりません。"), 404);
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json(error("操作元を確認できません。ページを開き直してください。"), 403);
  if (path === "/auth/sign-in/social" && (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET))
    return c.json(error("Googleログインは準備中です。"), 503);
  // 遷移先とプロバイダーはサーバーで固定し、汎用プロフィール更新APIを公開しません。
  return createAuth(c.env).handler(
    new Request(`${c.env.APP_ORIGIN}/api${path}`, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(
        path === "/auth/sign-out"
          ? {}
          : {
              provider: "google",
              callbackURL: "/account",
              newUserCallbackURL: "/account/setup",
              errorCallbackURL: "/login?error=oauth",
            },
      ),
    }),
  );
});
accountRoutes.get("/account/session", async (c) => {
  const user = await accountIdentity(c.req.raw, c.env);
  return c.json(accountSessionSchema.parse({ user: user ? publicProfile(user) : null }));
});
accountRoutes.get("/avatars/:id", async (c) => {
  const key = `avatars/${c.req.param("id")}.webp`;
  if (!avatarKeyPattern.test(key)) return c.notFound();
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
  let image = user.image;
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
    await c.env.OBJECT_STORAGE.put(avatarKey, avatarBytes, {
      httpMetadata: { contentType: "image/webp" },
    });
  } else if (avatarAction === "remove") {
    avatarKey = null;
    image = null;
  }
  let changed = false;
  try {
    // 同時編集で参照中の画像を消さず、旧画像の削除待ちをプロフィールと同時に保存します。
    const results = await c.env.APP_DB.batch([
      c.env.APP_DB.prepare(`UPDATE user SET name = ?, username = ?, profileCompleted = 1, image = ?, avatarKey = ?, updatedAt = ?
        WHERE id = ? AND COALESCE(profileCompleted, 0) = ? AND avatarKey IS ? RETURNING id`).bind(
        input.data.name,
        input.data.username,
        image,
        avatarKey,
        Date.now(),
        user.id,
        expectedCompleted,
        user.avatarKey,
      ),
      c.env.APP_DB.prepare(
        "INSERT OR IGNORE INTO avatar_deletions (key) SELECT ? WHERE ? IS NOT NULL AND ? IS NOT ? AND changes() = 1",
      ).bind(user.avatarKey, user.avatarKey, user.avatarKey, avatarKey),
    ]);
    changed = results[0].results.length === 1;
  } catch (err) {
    if (uploadedKey) await c.env.OBJECT_STORAGE.delete(uploadedKey);
    if (err instanceof Error && /unique/i.test(err.message))
      return c.json(error("このIDはすでに使われています。"), 409);
    throw err;
  }
  if (!changed) {
    if (uploadedKey) await c.env.OBJECT_STORAGE.delete(uploadedKey);
    return c.json(error("設定が更新されています。ページを開き直してください。"), 409);
  }
  c.executionCtx.waitUntil(deleteUnusedAvatars(c.env));
  return c.json(publicProfile({ ...user, ...input.data, profileCompleted: 1, image, avatarKey }));
});
export async function deleteUnusedAvatars(env: Env) {
  const rows = await env.APP_DB.prepare("SELECT key FROM avatar_deletions LIMIT 100").all<{
    key: string;
  }>();
  for (const { key } of rows.results) {
    if (!avatarKeyPattern.test(key)) continue;
    if (
      await env.APP_DB.prepare("SELECT id FROM user WHERE avatarKey = ? LIMIT 1").bind(key).first()
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
