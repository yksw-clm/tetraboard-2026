import { gameCatalog, gameIds } from "@tetraboard/protocol/games";

const publicPaths = gameIds.flatMap((game) => [
  gameCatalog[game].lobbyPath,
  `${gameCatalog[game].lobbyPath}/rules`,
]);
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
  const canonical = publicPaths.find(
    (candidate) =>
      path === candidate || path === `${candidate}/` || path === `${candidate}/index.html`,
  );
  if (canonical && url.pathname !== canonical) {
    url.pathname = canonical;
    return Response.redirect(url.toString(), 308);
  }
  if (request.headers.get("Upgrade"))
    return withoutIndexing(new Response("Not Found", { status: 404 }));
  if (request.method !== "GET" && request.method !== "HEAD")
    return withoutIndexing(
      new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } }),
    );
  const privatePage =
    ["/", "/index.html", "/login", "/account", "/account/setup", "/feedback", "/updates"].includes(
      path,
    ) ||
    /^\/rooms\/[^/]+\/?$/.test(path) ||
    /^\/account\/matches\/[^/]+\/?$/.test(path);
  if (canonical || privatePage) {
    url.pathname = canonical ? `${canonical}/index.html` : "/index.html";
    const response = await assets.fetch(new Request(url, request));
    return canonical && response.status < 400 ? response : withoutIndexing(response);
  }
  if (
    path.startsWith("/assets/") ||
    ["/favicon.ico", "/robots.txt", "/sitemap.xml"].includes(path)
  ) {
    url.pathname = path;
    const response = await assets.fetch(new Request(url, request));
    return response.status === 404 ? withoutIndexing(response) : response;
  }
  url.pathname = "/404.html";
  const response = await assets.fetch(new Request(url, request));
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, follow");
  return new Response(request.method === "HEAD" ? null : response.body, { status: 404, headers });
}
