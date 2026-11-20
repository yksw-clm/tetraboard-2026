import { Hono } from "hono";
import { avatarPresets } from "@tetraboard/protocol";
import { avatarKeyPattern } from "../adapters/account/auth";
export const avatarRoutes = new Hono<{ Bindings: Env }>();
avatarRoutes.get("/avatars/:id", async (c) => {
  const preset = avatarPresets.find((candidate) => candidate.id === c.req.param("id"));
  if (preset) {
    const path = `/assets/avatar-presets/v1/${preset.file}`;
    if (!c.env.ASSETS) {
      if (new URL(c.env.APP_ORIGIN).protocol !== "http:") return c.notFound();
      // ローカル開発では同一オリジンのViteがpublic配下の画像を配信します。
      c.header("Cache-Control", "no-store");
      return c.redirect(path);
    }
    const url = new URL(path, c.req.url);
    const response = await c.env.ASSETS.fetch(new Request(url, c.req.raw));
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "image/webp");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", response.ok ? "public, max-age=3600" : "no-store");
    return new Response(response.body, { status: response.status, headers });
  }
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
