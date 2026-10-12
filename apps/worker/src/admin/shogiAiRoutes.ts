import { Hono } from "hono";
import {
  aiProfileSchema,
  aiRunsSchema,
  aiStatusSchema,
  signAiRequest,
} from "@tetraboard/protocol/shogi-ai";
import { adminIdentity, type AdminEnv } from "./auth";
type AiEnv = AdminEnv & { SHOGI_AI_API_URL?: string; SHOGI_AI_MONITOR_KEY?: string };
export const shogiAiAdminRoutes = new Hono<{ Bindings: AiEnv }>();
shogiAiAdminRoutes.use("/admin/four-shogi-ai/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const result = await adminIdentity(c.req.raw, c.env);
  if (result.status !== 200) return c.json({ message: result.message }, result.status);
  await next();
});
export async function readAiResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("AI unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 256 * 1024) throw new Error("AI response too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function fetchAi(env: AiEnv, path: string) {
  if (!env.SHOGI_AI_API_URL || !env.SHOGI_AI_MONITOR_KEY || env.SHOGI_AI_MONITOR_KEY.length < 32)
    throw new Error("AI not configured");
  const url = new URL(env.SHOGI_AI_API_URL);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname) &&
        env.APP_ORIGIN.startsWith("http://localhost"))
    )
  )
    throw new Error("Invalid AI origin");
  const at = Date.now(),
    nonce = crypto.randomUUID();
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 2000);
  try {
    const signature = await signAiRequest(env.SHOGI_AI_MONITOR_KEY, "GET", path, "", at, nonce);
    const response = await fetch(new URL(path, url), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { "x-ai-at": String(at), "x-ai-nonce": nonce, "x-ai-signature": signature },
    });
    return await readAiResponse(response);
  } finally {
    clearTimeout(timer);
  }
}
shogiAiAdminRoutes.get("/admin/four-shogi-ai/status", async (c) => {
  try {
    return c.json(aiStatusSchema.parse(await fetchAi(c.env, "/v1/admin/status")));
  } catch {
    return c.json(
      { message: "自己対局サーバーに接続できません。設定と稼働状態を確認してください。" },
      503,
    );
  }
});
shogiAiAdminRoutes.get("/admin/four-shogi-ai/runs", async (c) => {
  const query = c.req.query();
  if (
    Object.keys(query).some((k) => !["profileId", "cursor"].includes(k)) ||
    (query.profileId && !aiProfileSchema.safeParse(query.profileId).success) ||
    (query.cursor && !/^[a-zA-Z0-9_-]{1,120}$/.test(query.cursor))
  )
    return c.json({ message: "検索条件が正しくありません。" }, 400);
  const params = new URLSearchParams(query),
    path = "/v1/admin/runs" + (params.size ? "?" + params.toString() : "");
  try {
    return c.json(aiRunsSchema.parse(await fetchAi(c.env, path)));
  } catch {
    return c.json({ message: "自己対局の履歴を取得できません。" }, 503);
  }
});
