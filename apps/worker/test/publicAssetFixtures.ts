import { env } from "cloudflare:workers";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { formationCatalog } from "@tetraboard/four-shogi/formation-catalog";
import worker from "../src/worker";

export const files: Record<string, { body: string; type: string }> = {
  ...Object.fromEntries(
    gameIds.map((game) => [
      `/games/${game}/index.html`,
      {
        body: `<h1>${gameCatalog[game].name}</h1><meta name="robots" content="index,follow">`,
        type: "text/html; charset=utf-8",
      },
    ]),
  ),
  "/games/four-shogi/rules/index.html": {
    body: '<h1>四人将棋のルール</h1><meta name="robots" content="index,follow">',
    type: "text/html; charset=utf-8",
  },
  "/app.html": {
    body: '<html><head><title>TetraBoard</title><meta property="og:site_name" content="TetraBoard"><meta name="robots" content="noindex,follow"></head><body><div id="root"></div></body></html>',
    type: "text/html; charset=utf-8",
  },
  "/index.html": {
    body: '<html><head><title>TetraBoard</title><meta name="robots" content="noindex,follow"></head><body><div id="root"></div></body></html>',
    type: "text/html; charset=utf-8",
  },
  "/404.html": {
    body: '<h1>ページが見つかりません。</h1><a href="/games/four-shogi">四人将棋</a><a href="/games/four-reversi">四人リバーシ</a>',
    type: "text/html; charset=utf-8",
  },
  "/robots.txt": {
    body: "User-agent: *\nAllow: /\nSitemap: https://tetraboard.net/sitemap.xml",
    type: "text/plain; charset=utf-8",
  },
  "/sitemap.xml": {
    body: `<urlset>${["/", ...gameIds.map((game) => gameCatalog[game].lobbyPath)]
      .map(
        (path) =>
          `<url><loc>https://tetraboard.net${path}</loc><lastmod>2026-10-15</lastmod></url>`,
      )
      .join(
        "",
      )}<url><loc>https://tetraboard.net/games/four-shogi/rules</loc><lastmod>2026-11-21</lastmod></url></urlset>`,
    type: "application/xml",
  },
  "/assets/app.js": { body: "export {};", type: "application/javascript" },
  ...Object.fromEntries(
    [...gameIds, "tetraboard"].map((game) => [
      `/assets/ogp/${game}.png`,
      { body: `share image: ${game}`, type: "image/png" },
    ]),
  ),
  ...Object.fromEntries(
    formationCatalog.map(({ id }) => [
      `/four-shogi/formations/${id}.jpg`,
      { body: `formation image: ${id}`, type: "image/jpeg" },
    ]),
  ),
};

export function assetFixture(bindings: Partial<Env> = {}) {
  const calls: Request[] = [];
  const assets = {
    async fetch(request: Request) {
      calls.push(request);
      const file = files[new URL(request.url).pathname];
      if (!file) return new Response("asset missing", { status: 404 });
      const headers = {
        "Content-Type": file.type,
        ETag: '"fixture"',
        "Cache-Control": "public, max-age=0, must-revalidate",
      };
      if (request.headers.get("If-None-Match") === '"fixture"')
        return new Response(null, { status: 304, headers });
      return new Response(request.method === "HEAD" ? null : file.body, { headers });
    },
  } as Fetcher;
  const configured = {
    ...env,
    APP_ORIGIN: "https://tetraboard.net" as const,
    ASSETS: assets,
    ...bindings,
  };
  return {
    calls,
    fetch: (path: string, options?: RequestInit) =>
      worker.fetch(
        new Request(`${configured.APP_ORIGIN}${path}`, options),
        configured,
        {} as ExecutionContext,
      ),
  };
}
