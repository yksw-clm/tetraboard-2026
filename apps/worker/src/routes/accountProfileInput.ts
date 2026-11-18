import { profileInputSchema, profileDetailsSchema } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import type { AccountRouteContext } from "./accountRoutes";
const error = (message: string) => ({ message });
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
export async function readProfileForm(c: AccountRouteContext, action: string) {
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
  return data;
}
export function parseProfileForm(c: AccountRouteContext, data: FormData) {
  const input = profileInputSchema.safeParse({
    name: data.get("name"),
    username: data.get("username"),
  });
  if (!input.success)
    return c.json(error("名前は1〜10文字、IDは半角英数字と_の3〜20文字にしてください。"), 400);
  let favoriteGames: unknown;
  if (data.has("favoriteGames")) {
    try {
      const value = data.get("favoriteGames");
      if (typeof value !== "string") throw new Error();
      favoriteGames = JSON.parse(value);
    } catch {
      return c.json(error("お気に入りゲームは一覧から3つまで選んでください。"), 400);
    }
  }
  const details = profileDetailsSchema.partial().safeParse({
    ...(data.has("profileMessage") ? { profileMessage: data.get("profileMessage") } : {}),
    ...(data.has("favoriteGames") ? { favoriteGames } : {}),
  });
  if (!details.success)
    return c.json(
      error("ひとことは改行なしの30文字以内、お気に入りゲームは一覧から3つまで指定してください。"),
      400,
    );
  return { input: input.data, details: details.data };
}
