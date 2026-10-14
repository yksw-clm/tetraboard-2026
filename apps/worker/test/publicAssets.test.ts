import { expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import worker from "../src/worker";
import { formationCatalog } from "@tetraboard/four-shogi/formation-catalog";

const files: Record<string, { body: string; type: string }> = {
  ...Object.fromEntries(
    gameIds.map((game) => [
      `/games/${game}/index.html`,
      {
        body: `<h1>${gameCatalog[game].name}</h1><meta name="robots" content="index,follow">`,
        type: "text/html; charset=utf-8",
      },
    ]),
  ),
  "/app.html": {
    body: '<html><head><title>TetraBoard</title><meta name="robots" content="noindex,follow"></head><body><div id="root"></div></body></html>',
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
  "/sitemap.xml": { body: "<urlset></urlset>", type: "application/xml" },
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

function assetFixture() {
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
  const production = { ...env, APP_ORIGIN: "https://tetraboard.net" as const, ASSETS: assets };
  return {
    calls,
    fetch: (path: string, options?: RequestInit) =>
      worker.fetch(
        new Request(`https://tetraboard.net${path}`, options),
        production,
        {} as ExecutionContext,
      ),
  };
}

test("公開ロビーは通常UAとGooglebotへ同じHTMLを返し、HEAD・304・キャッシュを保持", async () => {
  const assets = assetFixture();
  for (const game of gameIds) {
    const path = `/games/${game}`;
    const user = await assets.fetch(path, { headers: { "User-Agent": "Mozilla/5.0" } });
    const bot = await assets.fetch(path, { headers: { "User-Agent": "Googlebot" } });
    expect(user.status).toBe(200);
    expect(user.headers.get("Content-Type")).toContain("text/html");
    expect(user.headers.get("X-Robots-Tag")).toBeNull();
    expect(await user.text()).toBe(await bot.text());
    const head = await assets.fetch(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const conditional = await assets.fetch(path, { headers: { "If-None-Match": '"fixture"' } });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("ETag")).toBe('"fixture"');
    expect(conditional.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(conditional.headers.get("X-Robots-Tag")).toBeNull();
  }
});

test("トップと公開URLの別表記はクエリを保持した恒久転送でアセットを読まない", async () => {
  const assets = assetFixture();
  for (const method of ["GET", "HEAD"]) {
    for (const [path, target] of [
      ["/index.html", "/"],
      ...gameIds.flatMap((game) => [
        [`/games/${game}/`, `/games/${game}`],
        [`/games/${game}/index.html`, `/games/${game}`],
      ]),
    ]) {
      const response = await assets.fetch(`${path}?source=example`, { method });
      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe(
        `https://tetraboard.net${target}?source=example`,
      );
    }
  }
  expect(assets.calls).toHaveLength(0);
});

test("全16戦法の画像をJPEGとして配信し、HEAD・304・キャッシュを保持", async () => {
  const assets = assetFixture();
  for (const { id } of formationCatalog) {
    const path = `/four-shogi/formations/${id}.jpg`;
    const response = await assets.fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new TextEncoder().encode(`formation image: ${id}`),
    );
    const head = await assets.fetch(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("image/jpeg");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const conditional = await assets.fetch(path, { headers: { "If-None-Match": '"fixture"' } });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("ETag")).toBe('"fixture"');
    expect(conditional.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
  }
});

test("既知SPA画面はnoindexで配信し、未知画面と欠落資産は本文付き404を返す", async () => {
  const assets = assetFixture();
  for (const path of [
    "/login",
    "/login/",
    "/account",
    "/account/setup",
    "/account/matches/example",
    "/matches/example",
    "/rooms/12345?invite=example",
    "/feedback",
    "/updates",
    "/updates/",
    "/updates/feedback",
    "/updates/feedback/",
  ]) {
    const response = await assets.fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(await response.text()).toContain('content="noindex,follow"');
    const conditional = await assets.fetch(path, { headers: { "If-None-Match": '"fixture"' } });
    expect(conditional.status).toBe(path.startsWith("/rooms/") ? 200 : 304);
    expect(conditional.headers.get("X-Robots-Tag")).toBe("noindex, follow");
  }
  for (const path of [
    "/unknown",
    "/updates/feedback/unknown",
    "/games/unknown",
    "/games/four-shogi/rules",
    "/assets/missing.js",
    "/four-shogi/formations/missing.jpg",
    "/four-shogi/unknown",
  ]) {
    const response = await assets.fetch(path, { headers: { "If-None-Match": '"fixture"' } });
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toContain('href="/games/four-reversi"');
    const head = await assets.fetch(path, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  }
});

test("robots・sitemap・資産のContent-Typeを保持し、画面のPOST・WebSocketを拒否", async () => {
  const assets = assetFixture();
  for (const [path, type] of [
    ["/robots.txt", "text/plain"],
    ["/sitemap.xml", "application/xml"],
    ["/assets/app.js", "application/javascript"],
  ]) {
    const response = await assets.fetch(path!);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(type!);
  }
  const post = await assets.fetch("/games/four-shogi", { method: "POST" });
  expect(post.status).toBe(405);
  expect(post.headers.get("Allow")).toBe("GET, HEAD");
  const upgrade = await assets.fetch("/games/four-shogi", { headers: { Upgrade: "websocket" } });
  expect(upgrade.status).toBe(404);
  const api = await assets.fetch("/api/missing");
  expect(api.status).toBe(404);
  expect(await api.text()).not.toContain("<h1>");
  const admin = await assets.fetch("/admin");
  expect(admin.status).not.toBe(200);
});

test("共有画像7枚のPNG配信・HEAD・304と欠落画像の404を維持する", async () => {
  const assets = assetFixture();
  for (const game of [...gameIds, "tetraboard"]) {
    const path = `/assets/ogp/${game}.png`;
    const response = await assets.fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new TextEncoder().encode(`share image: ${game}`),
    );
    const head = await assets.fetch(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await assets.fetch(path, { headers: { "If-None-Match": '"fixture"' } })).status).toBe(
      304,
    );
  }
  expect((await assets.fetch("/assets/ogp/missing.png")).status).toBe(404);
});

test("トップはGETとHEADで総合ロビーHTMLを転送せず配信する", async () => {
  const assets = assetFixture();
  for (const method of ["GET", "HEAD"]) {
    const response = await assets.fetch("/?source=example", { method });
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
  }
});
