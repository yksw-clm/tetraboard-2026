import { env } from "cloudflare:workers";
export const origin = "http://localhost:5173";
export async function accountFixture(completed = true, id = crypto.randomUUID() as string) {
  const now = Date.now();
  const username = `u_${id.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
  await env.APP_DB.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, username, profileCompleted) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
  )
    .bind(
      id,
      "登録名",
      `${id}@example.test`,
      now,
      now,
      completed ? username : null,
      completed ? 1 : 0,
    )
    .run();
  const token = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), id, token, now + 86400000, now, now)
    .run();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("tetraboard-local-only-secret-at-least-32-characters"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  const cookie = `tetraboard-2026.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
  return {
    id,
    username,
    cookie,
    token,
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
  };
}
