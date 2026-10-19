import { authSecret } from "../privacy/tokens";
import { readLimitedBody } from "../feedback/images";
import { Hono } from "hono";
import { profileInputSchema } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { consentStatement } from "../privacy/consent";
import { accountIdentity, appendSessionCookie, publicProfile, type StoredProfile } from "./auth";

export const guestLifetimeMs = 180 * 86400000;
const cookieName = "tetraboard-2026.guest";
export async function guestTokenHash(request: Request): Promise<string | null> {
  const token = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)tetraboard-2026\.guest=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function guestCookie(token: string, env: Env, maxAge = guestLifetimeMs / 1000) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(env.APP_ORIGIN).protocol === "https:" ? "; Secure" : ""}`;
}
export async function guestIdentity(request: Request, env: Env): Promise<StoredProfile | null> {
  const hash = await guestTokenHash(request);
  if (!hash) return null;
  const user =
    await env.APP_DB.prepare(`SELECT u.* FROM guest_sessions s JOIN user u ON u.id=s.account_id
    WHERE s.token_hash=? AND s.expires_at_ms>? AND u.isAnonymous=1
    AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=u.id)
    AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=u.id)`)
      .bind(hash, Date.now())
      .first<StoredProfile>();
  if (!user) return null;
  await env.APP_DB.prepare("UPDATE guest_sessions SET expires_at_ms=? WHERE token_hash=?")
    .bind(Date.now() + guestLifetimeMs, hash)
    .run();
  const token = request.headers
    .get("Cookie")!
    .match(/(?:^|;\s*)tetraboard-2026\.guest=([a-f0-9]{64})/)![1]!;
  appendSessionCookie(request, guestCookie(token, env));
  return user;
}
export async function createGuestAccount(
  request: Request,
  env: Env,
  name?: string,
): Promise<StoredProfile> {
  if (
    request.headers.get("Origin") !== env.APP_ORIGIN ||
    request.headers.get("X-Legal-Consent") !== legalVersion
  )
    throw new Error("Guest consent required");
  const now = Date.now(),
    id = crypto.randomUUID();
  const number = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 100000).padStart(5, "0");
  const user: StoredProfile = {
    id,
    name: name ?? `ゲスト${number}`,
    username: null,
    image: null,
    avatarKey: null,
    profileCompleted: 1,
    isAnonymous: 1,
    guestNameCustomized: name ? 1 : 0,
    publicProfileId: crypto.randomUUID(),
  };
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const hash = await guestTokenHash(
    new Request(request.url, { headers: { Cookie: `${cookieName}=${token}` } }),
  );
  await env.APP_DB.batch([
    env.APP_DB.prepare(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isAnonymous,username,profileCompleted,guestNameCustomized,publicProfileId)
      VALUES(?,?,?,0,?,?,1,NULL,1,?,?)`).bind(
      id,
      user.name,
      `${id}@guest.invalid`,
      now,
      now,
      user.guestNameCustomized,
      user.publicProfileId,
    ),
    env.APP_DB.prepare("INSERT INTO guest_sessions VALUES(?,?,?)").bind(
      hash,
      id,
      now + guestLifetimeMs,
    ),
    consentStatement(env.APP_DB, id),
  ]);
  appendSessionCookie(request, guestCookie(token, env));
  return user;
}
export async function clearGuestSession(request: Request, env: Env) {
  const hash = await guestTokenHash(request);
  if (hash)
    await env.APP_DB.prepare("DELETE FROM guest_sessions WHERE token_hash=?").bind(hash).run();
  appendSessionCookie(request, guestCookie("", env, 0));
}
async function guestInput(request: Request): Promise<{ name?: unknown } | null> {
  const bytes = await readLimitedBody(request, 4096);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as { name?: unknown };
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
  const name = profileInputSchema.shape.name.safeParse(data?.name);
  if (!name.success) return c.json({ message: "名前は1〜10文字で入力してください。" }, 400);
  const existing = await accountIdentity(c.req.raw, c.env);
  if (existing) {
    if (existing.isAnonymous && !existing.guestNameCustomized) {
      const changed = await c.env.APP_DB.prepare(
        "UPDATE user SET name=?,guestNameCustomized=1,updatedAt=? WHERE id=? AND isAnonymous=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id) RETURNING id",
      )
        .bind(name.data, Date.now(), existing.id)
        .first();
      if (!changed)
        return c.json({ message: "設定状態が変わりました。ページを開き直してください。" }, 409);
      return c.json(publicProfile({ ...existing, name: name.data, guestNameCustomized: 1 }));
    }
    return c.json(publicProfile(existing));
  }
  if (/(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(c.req.header("Cookie") ?? ""))
    return c.json({ message: "ログイン状態を確認してください。" }, 401);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `guest-rate:${authSecret(c.env)}:${c.req.header("CF-Connecting-IP") ?? "local"}`,
    ),
  );
  const key = `guest:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`,
    now = Date.now();
  const rate =
    await c.env.APP_DB.prepare(`INSERT INTO rateLimit(id,key,count,lastRequest) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN lastRequest<? THEN 1 ELSE count+1 END,lastRequest=CASE WHEN lastRequest<? THEN excluded.lastRequest ELSE lastRequest END RETURNING count`)
      .bind(key, key, now, now - 60000, now - 60000)
      .first<{ count: number }>();
  if (rate && rate.count > 20)
    return c.json({ message: "作成が多すぎます。1分ほど待ってください。" }, 429);
  return c.json(publicProfile(await createGuestAccount(c.req.raw, c.env, name.data)), 201);
});
guestRoutes.patch("/account/guest/name", async (c) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const user = await accountIdentity(c.req.raw, c.env);
  if (!user?.isAnonymous) return c.json({ message: "ゲストとして参加してください。" }, 401);
  const data = await guestInput(c.req.raw);
  const name = profileInputSchema.shape.name.safeParse(data?.name);
  if (!name.success) return c.json({ message: "名前は1〜10文字で入力してください。" }, 400);
  const changed = await c.env.APP_DB.prepare(
    "UPDATE user SET name=?,guestNameCustomized=1,updatedAt=? WHERE id=? AND isAnonymous=1 AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=user.id) RETURNING id",
  )
    .bind(name.data, Date.now(), user.id)
    .first();
  if (!changed)
    return c.json({ message: "設定状態が変わりました。ページを開き直してください。" }, 409);
  return c.json(publicProfile({ ...user, name: name.data, guestNameCustomized: 1 }));
});
