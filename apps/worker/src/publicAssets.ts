import { legalHtml } from "./routes/legalHtml";
import { fourShogiRulesPath, gameCatalog, gameIds, isGameId } from "@tetraboard/protocol/games";
import { serveRoomShareHtml } from "./roomShareHtml";
import { serveMatchShareHtml } from "./matchSharing/html";
import { withVisitHtml } from "./usageEvents/visit";
import { serveTournamentHtml, serveTournamentSitemap } from "./tournamentPages";
import { serveBoardHtml, serveBoardSitemap } from "./boardPages";

const boardTimelinePath = /^\/games\/([^/]+)\/posts\/?$/;
const boardDetailPath = /^\/posts\/([^/]+)\/?$/;

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
    /^\/(?:rooms|matches|players|updates)\/[^/]+\/?$/.test(path) ||
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

function rejectAssetRequest(request: Request, board: boolean) {
  const upgrade = request.headers.has("Upgrade");
  if (!upgrade && (request.method === "GET" || request.method === "HEAD")) return null;
  const headers = new Headers({ "Content-Type": "text/plain;charset=UTF-8" });
  if (board) headers.set("Cache-Control", "no-store");
  if (!upgrade) headers.set("Allow", "GET, HEAD");
  const message = upgrade ? "Not Found" : "Method Not Allowed";
  return withoutIndexing(
    new Response(request.method === "HEAD" ? null : message, {
      status: upgrade ? 404 : 405,
      headers,
    }),
  );
}

function redirectToPath(url: URL, path: string) {
  url.pathname = path;
  return Response.redirect(url.toString(), 308);
}

export async function servePublicAssets(
  request: Request,
  assets: Fetcher,
  path: string,
  env?: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const html = (response: Response) => withVisitHtml(request, response, path);
  const boardTimeline = boardTimelinePath.exec(path);
  const boardDetail = boardDetailPath.exec(path);
  const boardSitemap = path === "/sitemap-posts.xml";
  const boardRequest = Boolean(boardTimeline || boardDetail || boardSitemap);
  const rejection = rejectAssetRequest(request, boardRequest);
  if (rejection) return rejection;
  if (boardTimeline)
    return isGameId(boardTimeline[1])
      ? html(await serveBoardHtml(request, assets, env))
      : serveNotFoundAsset(request, url, assets);
  if (boardDetail && path.endsWith("/")) return redirectToPath(url, path.slice(0, -1));
  if (boardDetail) return html(await serveBoardHtml(request, assets, env, boardDetail[1]));
  if (boardSitemap && env?.APP_ORIGIN === "https://tetraboard.net")
    return serveBoardSitemap(request, env);
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
