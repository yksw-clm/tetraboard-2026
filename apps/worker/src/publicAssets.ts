import { defaultGameId, gameCatalog, gameIds } from "@tetraboard/protocol/games";

export function withoutIndexing(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, follow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function servePublicAssets(
  request: Request,
  assets: Fetcher,
  path: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("Upgrade"))
    return withoutIndexing(new Response("Not Found", { status: 404 }));
  if (request.method !== "GET" && request.method !== "HEAD")
    return withoutIndexing(
      new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } }),
    );
  if (path === "/") {
    url.pathname = gameCatalog[defaultGameId].lobbyPath;
    return Response.redirect(url.toString(), 308);
  }
  const game = gameIds.find((id) => {
    const lobby = gameCatalog[id].lobbyPath;
    return path === lobby || path === `${lobby}/` || path === `${lobby}/index.html`;
  });
  if (game) {
    const lobby = gameCatalog[game].lobbyPath;
    if (url.pathname !== lobby) {
      url.pathname = lobby;
      return Response.redirect(url.toString(), 308);
    }
    url.pathname = `${lobby}/index.html`;
    const response = await assets.fetch(new Request(url, request));
    return response.status < 400 ? response : withoutIndexing(response);
  }
  const spa =
    ["/index.html", "/login", "/account", "/account/setup", "/feedback", "/updates"].includes(
      path.replace(/\/$/, ""),
    ) ||
    /^\/(?:rooms|matches|updates)\/[^/]+\/?$/.test(path) ||
    /^\/account\/matches\/[^/]+\/?$/.test(path);
  if (spa) {
    url.pathname = "/index.html";
    return withoutIndexing(await assets.fetch(new Request(url, request)));
  }
  if (
    path.startsWith("/assets/") ||
    path.startsWith("/four-shogi/formations/") ||
    ["/favicon.ico", "/robots.txt", "/sitemap.xml"].includes(path)
  ) {
    url.pathname = path;
    const response = await assets.fetch(new Request(url, request));
    if (response.status !== 404) return response;
  }
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
