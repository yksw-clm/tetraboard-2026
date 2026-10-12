import {
  aiProfileSchema,
  aiRunsSchema,
  aiStatusSchema,
  signAiRequest,
} from "@tetraboard/protocol/shogi-ai";
import { AiStore } from "./store";
export function createApi(store: AiStore, token: string) {
  if (token.length < 32) throw new Error("AI_MONITOR_KEY must contain at least 32 characters");
  const nonces = new Map<string, number>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const response = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
    if (url.pathname === "/healthz" && request.method === "GET") return response({ status: "ok" });
    if (request.method !== "GET" || !["/v1/admin/status", "/v1/admin/runs"].includes(url.pathname))
      return response({ message: "Not found" }, 404);
    const at = Number(request.headers.get("x-ai-at")),
      nonce = request.headers.get("x-ai-nonce") ?? "",
      signature = request.headers.get("x-ai-signature") ?? "";
    if (
      !Number.isSafeInteger(at) ||
      Math.abs(Date.now() - at) > 30000 ||
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return response({ message: "Unauthorized" }, 401);
    const expected = await signAiRequest(token, "GET", url.pathname + url.search, "", at, nonce);
    let difference = 0;
    for (let i = 0; i < 64; i++) difference |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    for (const [key, time] of nonces) if (Date.now() - time > 60000) nonces.delete(key);
    if (difference !== 0 || nonces.has(nonce) || nonces.size >= 10000)
      return response({ message: "Unauthorized" }, 401);
    nonces.set(nonce, Date.now());
    try {
      if (url.pathname === "/v1/admin/status") {
        const saved = store.get("status");
        if (!saved) return response({ message: "Initialising" }, 503);
        return response(aiStatusSchema.parse(saved));
      }
      if ([...url.searchParams.keys()].some((k) => !["profileId", "cursor"].includes(k)))
        return response({ message: "Invalid query" }, 400);
      const profile = url.searchParams.get("profileId"),
        cursor = url.searchParams.get("cursor") ?? undefined;
      const parsed = profile === null ? null : aiProfileSchema.safeParse(profile);
      if ((parsed && !parsed.success) || (cursor && !/^[a-zA-Z0-9_-]{1,120}$/.test(cursor)))
        return response({ message: "Invalid query" }, 400);
      const runs = store.runs(parsed?.success ? parsed.data : undefined, cursor);
      return response(
        aiRunsSchema.parse({
          runs: runs.slice(0, 20),
          nextCursor: runs.length > 20 ? runs[19].id : null,
        }),
      );
    } catch {
      return response({ message: "Data unavailable" }, 503);
    }
  };
}
