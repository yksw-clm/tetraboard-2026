import { Hono } from "hono";
import { z } from "zod";
import { gameIds } from "@tetraboard/protocol/games";
import { normalizePublicAssetPath } from "../publicAssetPath";
import { classifyDevice, classifyReferrer, sanitizeUtm } from "./acquisition";
import { analyticsCookie, browserIdFromRequest } from "./browserId";
import { readBody } from "./readBody";
import { createUsageEventWriter } from "./writer";

const inputSchema = z.strictObject({
  path: z.string().startsWith("/").max(1024),
  referrerHost: z.string().max(253).nullable(),
  utmSource: z.string().max(256).nullable(),
  utmMedium: z.string().max(256).nullable(),
  utmCampaign: z.string().max(256).nullable(),
});

export function isBrowserUserAgent(userAgent: string | null): boolean {
  return !!userAgent?.includes("Mozilla/") && !/bot|crawler|spider|headless/i.test(userAgent);
}

function pageType(path: string): string {
  return path === "/"
    ? "general-lobby"
    : path.startsWith("/games/")
      ? "lobby"
      : path.startsWith("/rooms/")
        ? "room"
        : path.startsWith("/account/matches/") || path.startsWith("/matches/")
          ? "replay"
          : path === "/account/setup"
            ? "setup"
            : path === "/login"
              ? "login"
              : path === "/account"
                ? "account"
                : "other";
}

function isExcludedVisitPath(path: string): boolean {
  return (
    ["/privacy", "/terms", "/admin", "/api"].includes(path) ||
    path.startsWith("/admin/") ||
    path.startsWith("/api/")
  );
}

export const visitRoutes = new Hono<{ Bindings: Env }>();
visitRoutes.post("/visits", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json({ message: "操作元を確認できません。" }, 403);
  const input = inputSchema.safeParse(await readBody(c.req.raw));
  if (!input.success) return c.body(null, 400);

  const ua = c.req.raw.headers.get("User-Agent");
  const browserId = browserIdFromRequest(c.req.raw);
  if (!isBrowserUserAgent(ua) || !browserId) return c.body(null, 204);

  const { path, referrerHost, utmSource, utmMedium, utmCampaign } = input.data;
  const assetPath = normalizePublicAssetPath(path) ?? path;
  if (isExcludedVisitPath(path) || isExcludedVisitPath(assetPath)) return c.body(null, 204);

  const referrer = classifyReferrer(referrerHost, new URL(c.req.url).hostname);
  const device = classifyDevice(ua);
  const pathSegments = assetPath.split("/");
  createUsageEventWriter(c.env.USAGE_EVENTS).write({
    name: "visit_started",
    isTest: false,
    browserId,
    accountId: "",
    page: pageType(assetPath),
    game: gameIds.find((id) => pathSegments.includes(id)) ?? null,
    referrerClass: referrer.category ?? "",
    referrerHost: referrer.host,
    utmSource: sanitizeUtm(utmSource),
    utmMedium: sanitizeUtm(utmMedium),
    utmCampaign: sanitizeUtm(utmCampaign),
    device: device === "mobile" ? "smartphone" : device === "tablet" ? "tablet" : "pc",
  });
  return c.body(null, 204);
});

export function withVisitCookie(request: Request, response: Response, path: string): Response {
  if (
    request.method !== "GET" ||
    request.headers.has("Upgrade") ||
    !response.ok ||
    response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "text/html" ||
    ["/privacy", "/terms"].includes(path) ||
    path.startsWith("/admin") ||
    path.startsWith("/api") ||
    !isBrowserUserAgent(request.headers.get("User-Agent")) ||
    browserIdFromRequest(request)
  )
    return response;

  return withAnalyticsCookie(response, crypto.randomUUID(), new URL(request.url));
}

function withAnalyticsCookie(response: Response, browserId: string, url: URL): Response {
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${analyticsCookie}=${browserId}; Path=/; Max-Age=31536000; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`,
  );
  // publicだけを除き、no-storeや再検証など既存の制約を保ちます。
  const directives = (headers.get("Cache-Control") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && !/^public$/i.test(value));
  if (!directives.some((value) => /^private$/i.test(value))) directives.unshift("private");
  headers.set("Cache-Control", directives.join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
