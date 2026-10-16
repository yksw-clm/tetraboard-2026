import { createHash, timingSafeEqual } from "node:crypto";
import {
  aiHashSchema,
  aiJobLookupSchema,
  aiJobRequestSchema,
} from "@tetraboard/protocol/four-shogi-ai";
import { JobManager, ServiceError } from "./jobs";

export async function limitedJson(request: Request, limit: number) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new ServiceError("json_required", 415);
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new ServiceError("request_size_limit", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError("invalid_json", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ServiceError("body_timeout", 408)), 5000);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.length;
      if (size > limit) throw new ServiceError("request_size_limit", 413);
      chunks.push(value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as unknown;
    } catch {
      throw new ServiceError("invalid_json", 400);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
const digest = (value: string) => createHash("sha256").update(value).digest();
export function createServiceHandler(manager: JobManager, onShutdown: () => void = () => {}) {
  const expected = digest(manager.config.secret);
  return async (request: Request): Promise<Response> => {
    const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
    try {
      const auth = request.headers.get("authorization") ?? "";
      if (
        !auth.startsWith("Bearer ") ||
        auth.length > 263 ||
        !timingSafeEqual(expected, digest(auth.slice(7)))
      )
        throw new ServiceError("unauthenticated", 401);
      const path = new URL(request.url).pathname;
      if (path === "/v1/health" && request.method === "GET") {
        const health = manager.health();
        return respond(health, health.status === "ready" ? 200 : 503);
      }
      if (path === "/v1/shutdown" && request.method === "POST") {
        manager.stopAccepting();
        onShutdown();
        return respond({ status: "stopping" }, 202);
      }
      if (path === "/v1/jobs" && request.method === "POST") {
        const raw = await limitedJson(request, manager.config.maxRequestBytes);
        const events = (raw as { position?: { events?: unknown } } | null)?.position?.events;
        if (Array.isArray(events) && events.length > manager.config.maxEvents)
          throw new ServiceError("request_size_limit", 413);
        const parsed = aiJobRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ServiceError("invalid_request", 400);
        const result = manager.submit(
          parsed.data,
          digest(JSON.stringify(parsed.data)).toString("hex"),
        );
        return respond(
          result,
          result.status === "queued" || result.status === "running" ? 202 : 200,
        );
      }
      const job = /^\/v1\/jobs\/([^/]+)$/.exec(path);
      if (job && ["GET", "DELETE"].includes(request.method)) {
        const parsed = aiJobLookupSchema.safeParse({
          jobId: job[1],
          serviceInstanceId: request.headers.get("x-ai-instance"),
        });
        const principal = aiHashSchema.safeParse(request.headers.get("x-ai-principal"));
        if (!parsed.success || !principal.success) throw new ServiceError("invalid_request", 400);
        return respond(
          request.method === "GET"
            ? manager.get(parsed.data.jobId, principal.data, parsed.data.serviceInstanceId)
            : manager.cancel(parsed.data.jobId, principal.data, parsed.data.serviceInstanceId),
        );
      }
      throw new ServiceError("not_found", 404);
    } catch (error) {
      const failure =
        error instanceof ServiceError ? error : new ServiceError("internal_error", 503);
      return respond(
        { error: failure.code, retryAfterMs: failure.retryAfterMs },
        failure.status,
        failure.retryAfterMs
          ? { "Retry-After": String(Math.ceil(failure.retryAfterMs / 1000)) }
          : {},
      );
    }
  };
}
