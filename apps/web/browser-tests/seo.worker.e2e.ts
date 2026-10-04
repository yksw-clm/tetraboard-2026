import { expect, test } from "@playwright/test";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { publicPages, publicOrigin } from "../src/publicPages/catalog";

test("実Workerが公開4ページの初期HTML・XML・robotsとHTTP境界を配信する", async ({
  request,
  browser,
  baseURL,
}) => {
  for (const game of gameIds) {
    for (const kind of ["lobby", "rules"] as const) {
      const entry = publicPages[game][kind];
      const response = await request.get(entry.path);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      expect(response.headers()["x-robots-tag"]).toBeUndefined();
      const html = await response.text();
      expect(html).toContain(entry.title);
      expect(html).toContain(`href="${publicOrigin}${entry.path}"`);
      expect(html).toContain(`content="${publicOrigin}${entry.path}"`);
      expect(html).toContain('name="robots" content="index,follow"');
      expect(html).toContain("<h1");
      expect(html).toContain(gameCatalog[game].name);
      expect(html).toContain(kind === "rules" ? "投了、通信切れと持ち時間" : "ユーザー登録なし");
      const etag = response.headers().etag;
      expect(etag).toBeDefined();
      const cached = await request.get(entry.path, { headers: { "If-None-Match": etag! } });
      expect(cached.status()).toBe(304);
      expect(cached.headers()["x-robots-tag"]).toBeUndefined();
      expect(await cached.body()).toHaveLength(0);
      const crawler = await request.get(entry.path, { headers: { "User-Agent": "Googlebot" } });
      expect(await crawler.text()).toBe(html);
      const head = await request.head(entry.path);
      expect(head.status()).toBe(200);
      expect(await head.body()).toHaveLength(0);
      for (const suffix of ["/", "/index.html"]) {
        const redirect = await request.get(`${entry.path}${suffix}?source=seo`, {
          maxRedirects: 0,
        });
        expect(redirect.status()).toBe(308);
        expect(redirect.headers().location).toBe(`${baseURL}${entry.path}?source=seo`);
      }
      const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
      try {
        const page = await context.newPage();
        await page.goto(entry.path);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(gameCatalog[game].name);
      } finally {
        await context.close();
      }
    }
  }
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toMatch(/xml/);
  const xml = await sitemap.text();
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locations).toEqual(
    gameIds.flatMap((game) => [
      publicOrigin + publicPages[game].lobby.path,
      publicOrigin + publicPages[game].rules.path,
    ]),
  );
  const robots = await request.get("/robots.txt");
  expect(robots.headers()["content-type"]).toContain("text/plain");
  expect(await robots.text()).toContain(`Sitemap: ${publicOrigin}/sitemap.xml`);
  for (const path of ["/missing-seo-page", "/games/unknown", "/games/four-shogi/rules/missing"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(404);
    expect(response.headers()["x-robots-tag"]).toContain("noindex");
    expect(await response.text()).toContain("ページが見つかりません");
  }
  for (const path of [
    "/",
    "/login",
    "/account",
    "/account/setup",
    "/rooms/12345",
    "/account/matches/example",
    "/feedback",
    "/updates",
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-robots-tag"]).toContain("noindex");
    expect(await response.text()).toContain('name="robots" content="noindex,follow"');
  }
  const api = await request.get("/api/missing-seo-api");
  expect(api.status()).toBe(404);
  expect(api.headers()["content-type"]).not.toContain("text/html");
  const method = await request.post("/games/four-shogi");
  expect(method.status()).toBe(405);
  expect(method.headers().allow).toBe("GET, HEAD");
  const admin = await request.get("/admin", { maxRedirects: 0 });
  expect(admin.status()).toBe(302);
  expect(admin.headers()["cache-control"]).toBe("no-store");
  expect(admin.headers()["x-robots-tag"]).toContain("noindex");
});
