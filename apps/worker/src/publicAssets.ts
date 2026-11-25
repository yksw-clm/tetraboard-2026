import { legalHtml } from "./routes/legalHtml";
import { fourShogiRulesPath, gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { serveRoomShareHtml } from "./roomShareHtml";
import { serveMatchShareHtml } from "./matchSharing/html";
import { withVisitHtml } from "./usageEvents/visit";
import { serveTournamentHtml, serveTournamentSitemap } from "./tournamentPages";

const publicPagePaths = [
  ...gameIds.map((game) => gameCatalog[game].lobbyPath),
  fourShogiRulesPath,
  "/how-to-play",
];
const tournamentDetailPath = /^\/tournaments\/([1-9]\d*)\/?$/;

export function withoutIndexing(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, follow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isSpaPath(path: string) {
  return (
    [
      "/index.html",
      "/login",
      "/account",
      "/account/setup",
      "/account/deletion",
      "/feedback",
      "/updates",
      "/tournaments",
      "/games/four-reversi/matchmaking",
      "/games/shogi/matchmaking",
    ].includes(path.replace(/\/$/, "")) ||
    /^\/(?:rooms|matches|updates)\/[^/]+\/?$/.test(path) ||
    tournamentDetailPath.test(path) ||
    /^\/account\/matches\/[^/]+\/?$/.test(path)
  );
}

async function serveNotFoundAsset(request: Request, url: URL, assets: Fetcher) {
  url.pathname = "/404.html";
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("If-None-Match");
  requestHeaders.delete("If-Modified-Since");
  const response = await assets.fetch(
    new Request(url, { method: request.method, headers: requestHeaders }),
  );
  const headers = new Headers(response.headers);
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, follow");
  return new Response(request.method === "HEAD" ? null : response.body, { status: 404, headers });
}

async function serveSpaAsset(request: Request, assets: Fetcher, path: string, env?: Env) {
  if (env) {
    const tournament = tournamentDetailPath.exec(path);
    if (tournament || path.replace(/\/$/, "") === "/tournaments")
      return serveTournamentHtml(
        request,
        assets,
        env,
        tournament ? Number(tournament[1]) : undefined,
      );
    if (/^\/matches\/[^/]+\/?$/.test(path)) return serveMatchShareHtml(request, env, assets);
    if (/^\/rooms\/[^/]+\/?$/.test(path)) return serveRoomShareHtml(request, env, assets);
  }
  const url = new URL(request.url);
  url.pathname = "/app.html";
  return withoutIndexing(await assets.fetch(new Request(url, request)));
}

export async function servePublicAssets(
  request: Request,
  assets: Fetcher,
  path: string,
  env?: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const html = (response: Response) => withVisitHtml(request, response, path);
  if (request.headers.get("Upgrade"))
    return withoutIndexing(new Response("Not Found", { status: 404 }));
  if (request.method !== "GET" && request.method !== "HEAD")
    return withoutIndexing(
      new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } }),
    );
  if (path === "/privacy" || path === "/terms")
    return legalHtml(request, assets, path.slice(1) as "privacy" | "terms");
  if (path === "/" || path === "/index.html") {
    if (path === "/index.html") {
      url.pathname = "/";
      return Response.redirect(url.toString(), 308);
    }
    url.pathname = "/index.html";
    return html(await assets.fetch(new Request(url, request)));
  }
  const publicPagePath = publicPagePaths.find(
    (page) => path === page || path === `${page}/` || path === `${page}/index.html`,
  );
  if (publicPagePath) {
    if (url.pathname !== publicPagePath) {
      url.pathname = publicPagePath;
      return Response.redirect(url.toString(), 308);
    }
    url.pathname = `${publicPagePath}/index.html`;
    const response = await assets.fetch(new Request(url, request));
    return html(response.status < 400 ? response : withoutIndexing(response));
  }
  if (isSpaPath(path)) return html(await serveSpaAsset(request, assets, path, env));
  if (
    path.startsWith("/assets/") ||
    path.startsWith("/four-shogi/formations/") ||
    ["/favicon.ico", "/robots.txt", "/sitemap.xml"].includes(path)
  ) {
    url.pathname = path;
    const assetRequest = new Request(url, request);
    const response =
      env && path === "/sitemap.xml"
        ? await serveTournamentSitemap(assetRequest, assets, env)
        : await assets.fetch(assetRequest);
    if (response.status !== 404) return response;
  }
  return serveNotFoundAsset(request, url, assets);
}
