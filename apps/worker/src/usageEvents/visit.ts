import { gameIds } from "@tetraboard/protocol/games";
import { classifyDevice, classifyReferrer, referrerHostname, sanitizeUtm } from "./acquisition";
import { createUsageEventWriter } from "./writer";

const analyticsCookie = "tetraboard-2026.analytics";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function withVisitStarted(
  request: Request,
  response: Response,
  path: string,
  env?: Pick<Env, "USAGE_EVENTS">,
): Response {
  const ua = request.headers.get("User-Agent");
  if (
    request.method !== "GET" ||
    request.headers.has("Upgrade") ||
    !response.ok ||
    response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "text/html" ||
    ["/privacy", "/terms"].includes(path) ||
    path.startsWith("/admin") ||
    path.startsWith("/api") ||
    /bot|crawler|spider/i.test(ua ?? "")
  )
    return response;

  const url = new URL(request.url);
  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${analyticsCookie}=`))
    ?.slice(analyticsCookie.length + 1);
  const existingId = cookie && uuidV4.test(cookie) ? cookie : null;
  const browserId = existingId ?? crypto.randomUUID();
  const referrer = classifyReferrer(
    referrerHostname(request.headers.get("Referer") ?? "", url.hostname),
    url.hostname,
  );
  const device = classifyDevice(ua);
  createUsageEventWriter(env?.USAGE_EVENTS).write({
    name: "visit_started",
    isTest: false,
    browserId,
    accountId: "",
    page: pageType(path),
    game: gameIds.find((id) => path.split("/").includes(id)) ?? null,
    referrerClass: referrer.category ?? "",
    referrerHost: referrer.host,
    utmSource: sanitizeUtm(url.searchParams.get("utm_source")),
    utmMedium: sanitizeUtm(url.searchParams.get("utm_medium")),
    utmCampaign: sanitizeUtm(url.searchParams.get("utm_campaign")),
    device: device === "mobile" ? "smartphone" : device === "tablet" ? "tablet" : "pc",
  });

  if (existingId) return response;
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
