import { Hono } from "hono";
import {
  accountSessionSchema,
  historyPageSchema,
  historyQuerySchema,
  profileInputSchema,
  rankingQuerySchema,
  rankingSchema,
  usernameSchema,
} from "@tetraboard/protocol";
import {
  accountIdentity,
  createAuth,
  publicProfile,
  type AuthEnv,
  type StoredProfile,
} from "./auth";
import { parseHistoryCursor, readHistory, readRanking, readStatistics } from "./historyStore";

export const accountRoutes = new Hono<{ Bindings: AuthEnv; Variables: { user: StoredProfile } }>();
const error = (message: string) => ({ message });
accountRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
accountRoutes.onError((err, c) => {
  console.error("Account request failed", err.name);
  return c.json(error("処理できませんでした。時間をおいてもう一度お試しください。"), 503);
});
accountRoutes.on(["GET", "POST"], "/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname.replace(/^\/api/, "");
  const allowed =
    c.req.method === "GET"
      ? /^\/auth\/(get-session|callback\/(google|discord))$/
      : /^\/auth\/(sign-in\/social|sign-out)$/;
  if (!allowed.test(path)) return c.json(error("見つかりません。"), 404);
  if (path === "/auth/sign-in/social") {
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { provider?: string } | null;
    const ready =
      body?.provider === "google"
        ? c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET
        : body?.provider === "discord"
          ? c.env.DISCORD_CLIENT_ID && c.env.DISCORD_CLIENT_SECRET
          : false;
    if (!ready) return c.json(error("このログイン方法は準備中です。"), 503);
  }
  // Better Authへ渡すパスは、Worker直接アクセスの場合も公開URLと統一します。
  const url = new URL(c.req.url);
  url.pathname = `/api${path}`;
  return createAuth(c.env).handler(new Request(url, c.req.raw));
});
accountRoutes.get("/account/session", async (c) => {
  const user = await accountIdentity(c.req.raw, c.env);
  return c.json(accountSessionSchema.parse({ user: user ? publicProfile(user) : null }));
});
accountRoutes.get("/games/four-reversi/ranking", async (c) => {
  const query = rankingQuerySchema.safeParse(c.req.query());
  if (!query.success) return c.json(error("指定が正しくありません。"), 400);
  return c.json(
    rankingSchema.parse(await readRanking(c.env.APP_DB, query.data.mode, query.data.metric)),
  );
});
accountRoutes.get("/avatars/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.notFound();
  const object = await c.env.OBJECT_STORAGE.get(`avatars/${id}.webp`);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
});
accountRoutes.use("/account/*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json(error("操作元を確認できません。ページを開き直してください。"), 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user) return c.json(error("ログインしてください。"), 401);
  c.set("user", user);
  if (c.req.method !== "GET") {
    const now = Date.now();
    const key = `profile:${user.id}`;
    const row =
      await c.env.APP_DB.prepare(`INSERT INTO rateLimit (id, key, count, lastRequest) VALUES (?, ?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = CASE WHEN lastRequest < ? THEN 1 ELSE count + 1 END,
      lastRequest = CASE WHEN lastRequest < ? THEN excluded.lastRequest ELSE lastRequest END RETURNING count`)
        .bind(key, key, now, now - 60_000, now - 60_000)
        .first<{ count: number }>();
    if (row && row.count > 20)
      return c.json(error("変更が多すぎます。1分ほど待ってください。"), 429);
  }
  await next();
});
accountRoutes.get("/account/username", async (c) => {
  const value = usernameSchema.safeParse(c.req.query("username"));
  if (!value.success) return c.json({ available: false });
  const row = await c.env.APP_DB.prepare(
    "SELECT id FROM user WHERE LOWER(username) = ? AND id <> ?",
  )
    .bind(value.data, c.get("user").id)
    .first();
  return c.json({ available: !row });
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
  const input = profileInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return c.json(error("名前は1〜10文字、IDは半角英数字と_の3〜20文字にしてください。"), 400);
  const user = c.get("user");
  if ((action === "setup") === Boolean(user.profileCompleted))
    return c.json(error("設定状態が変わりました。ページを開き直してください。"), 409);
  try {
    const updated = await c.env.APP_DB.prepare(
      "UPDATE user SET name = ?, username = ?, profileCompleted = 1, updatedAt = ? WHERE id = ? AND COALESCE(profileCompleted, 0) = ? RETURNING id",
    )
      .bind(input.data.name, input.data.username, Date.now(), user.id, action === "setup" ? 0 : 1)
      .first();
    if (!updated) return c.json(error("設定が更新されています。ページを開き直してください。"), 409);
  } catch (err) {
    if (err instanceof Error && /unique/i.test(err.message))
      return c.json(error("このIDはすでに使われています。"), 409);
    throw err;
  }
  return c.json(publicProfile({ ...user, ...input.data, profileCompleted: 1 }));
});
accountRoutes.put("/account/avatar", async (c) => {
  const length = Number(c.req.header("Content-Length"));
  if (length > 1024 * 1024 + 4096) return c.json(error("画像は1MB以下にしてください。"), 413);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json(error("画像を選択してください。"), 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) {
      await reader.cancel();
      return c.json(error("画像は1MB以下にしてください。"), 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (c.req.header("Content-Type") !== "image/webp" || !validAvatar(bytes))
    return c.json(error("256pxの正方形WebP画像に変換できませんでした。"), 400);
  const id = crypto.randomUUID();
  const key = `avatars/${id}.webp`;
  await c.env.OBJECT_STORAGE.put(key, bytes, { httpMetadata: { contentType: "image/webp" } });
  try {
    await c.env.APP_DB.prepare(
      "UPDATE user SET image = ?, avatarKey = ?, updatedAt = ? WHERE id = ?",
    )
      .bind(`/api/avatars/${id}`, key, Date.now(), c.get("user").id)
      .run();
  } catch (err) {
    await c.env.OBJECT_STORAGE.delete(key);
    throw err;
  }
  return c.json({ avatarUrl: `/api/avatars/${id}` });
});
accountRoutes.delete("/account/avatar", async (c) => {
  // 入室時・履歴のスナップショットから参照される画像は削除しません。
  await c.env.APP_DB.prepare(
    "UPDATE user SET image = NULL, avatarKey = NULL, updatedAt = ? WHERE id = ?",
  )
    .bind(Date.now(), c.get("user").id)
    .run();
  return c.body(null, 204);
});
for (const section of ["statistics", "history"] as const) {
  accountRoutes.get(`/account/${section}`, async (c) => {
    const query = historyQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json(error("指定が正しくありません。"), 400);
    try {
      parseHistoryCursor(query.data.cursor);
    } catch {
      return c.json(error("続きの指定が正しくありません。"), 400);
    }
    const { mode, cursor } = query.data;
    return section === "statistics"
      ? c.json(await readStatistics(c.env.APP_DB, c.get("user").id, mode))
      : c.json(
          historyPageSchema.parse(await readHistory(c.env.APP_DB, c.get("user").id, mode, cursor)),
        );
  });
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
