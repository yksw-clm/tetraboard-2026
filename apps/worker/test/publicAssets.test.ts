import { expect, test } from "vitest";
import { gameIds } from "@tetraboard/protocol/games";
import { formationCatalog } from "@tetraboard/four-shogi/formation-catalog";
import { assetFixture, visitMetaTag } from "./publicAssetFixtures";
import { recordUsageEvents } from "./usageEventsRecorder";

const analyticsCookie = "tetraboard-2026.analytics";
const conditionalHeaders = { "User-Agent": "Mozilla/5.0", "If-None-Match": '"fixture"' };

test.each([true, false])(
  "Cookieのないブラウザへの304で計測用Cookieを発行する（Content-Typeあり: %s）",
  async (hasContentType) => {
    const events = recordUsageEvents();
    const assets = hasContentType
      ? assetFixture()
      : assetFixture({
          ASSETS: {
            async fetch(request: Request) {
              expect(request.headers.get("If-None-Match")).toBe('"fixture"');
              return new Response(null, {
                status: 304,
                headers: {
                  ETag: '"fixture"',
                  "Cache-Control": "public, max-age=0, must-revalidate",
                },
              });
            },
          } as Fetcher,
        });
    const response = await assets.fetch("/games/four-shogi", { headers: conditionalHeaders });
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("Content-Type")).toBe(
      hasContentType ? "text/html; charset=utf-8" : null,
    );
    expect(response.headers.get("ETag")).toBe('"fixture"');
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(
        /^tetraboard-2026\.analytics=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/i,
      ),
    ]);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(events).toEqual([]);
  },
);

test.each([
  { method: "GET", cookie: `${analyticsCookie}=01234567-89ab-4cde-8fab-0123456789ab` },
  { method: "HEAD", cookie: null },
])(
  "有効なCookie付きのGETとHEADへの304ではCookieを発行しない: $method",
  async ({ method, cookie }) => {
    const events = recordUsageEvents();
    const requestHeaders = new Headers(conditionalHeaders);
    if (cookie) requestHeaders.set("Cookie", cookie);
    const response = await assetFixture().fetch("/games/four-shogi", {
      method,
      headers: requestHeaders,
    });
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(events).toEqual([]);
  },
);

test("公開ロビー・四人将棋のルール・利用ガイドは通常UAとGooglebotへ同じHTMLを返し、HEAD・304・キャッシュを保持", async () => {
  const assets = assetFixture();
  for (const path of [
    ...gameIds.map((game) => `/games/${game}`),
    "/games/four-shogi/rules",
    "/how-to-play",
  ]) {
    const user = await assets.fetch(path, { headers: { "User-Agent": "Mozilla/5.0" } });
    const bot = await assets.fetch(path, { headers: { "User-Agent": "Googlebot" } });
    expect(user.status).toBe(200);
    expect(user.headers.get("Content-Type")).toContain("text/html");
    expect(user.headers.get("X-Robots-Tag")).toBeNull();
    const body = await user.text();
    expect(body).toBe(await bot.text());
    expect(body.match(/<head>([\s\S]*?)<\/head>/)?.[1]).toContain(visitMetaTag);
    if (path === "/games/four-shogi/rules") expect(body).toContain("<h1>四人将棋のルール</h1>");
    if (path === "/how-to-play") expect(body).toContain("<h1>TetraBoardの使い方</h1>");
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
      ["/games/four-shogi/rules/", "/games/four-shogi/rules"],
      ["/games/four-shogi/rules/index.html", "/games/four-shogi/rules"],
      ["/how-to-play/", "/how-to-play"],
      ["/how-to-play/index.html", "/how-to-play"],
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
    const body = await response.text();
    expect(body).toContain('content="noindex,follow"');
    expect(body).toContain(`${visitMetaTag}</head>`);
    const head = await assets.fetch(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(await head.text()).toBe("");
    const conditional = await assets.fetch(path, { headers: { "If-None-Match": '"fixture"' } });
    expect(conditional.status).toBe(/^\/(rooms|matches)\//.test(path) ? 200 : 304);
    expect(conditional.headers.get("X-Robots-Tag")).toBe("noindex, follow");
  }
  for (const path of [
    "/404.html",
    "/unknown",
    "/updates/feedback/unknown",
    "/games/unknown",
    "/games/four-shogi/rules/unknown",
    "/games/shogi/rules",
    "/assets/missing.js",
    "/four-shogi/formations/missing.jpg",
    "/four-shogi/unknown",
  ]) {
    const response = await assets.fetch(path, { headers: { "If-None-Match": '"fixture"' } });
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain('href="/games/four-reversi"');
    expect(body).not.toContain(visitMetaTag);
    const head = await assets.fetch(path, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  }
});

test.each(["/privacy", "/terms"])("%s のHTMLには訪問の目印を付けない", async (path) => {
  const response = await assetFixture().fetch(path, { headers: { "User-Agent": "Mozilla/5.0" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(await response.text()).not.toContain(visitMetaTag);
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

test("大会詳細の範囲外のパスは404.htmlを返す", async () => {
  const assets = assetFixture();
  for (const path of [
    "/tournaments/0",
    "/tournaments/-1",
    "/tournaments/01",
    "/tournaments/draft",
    "/tournaments/1/extra",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await assets.fetch(path, {
        method,
        headers: { "If-None-Match": '"fixture"' },
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      if (method === "HEAD") expect(await response.text()).toBe("");
      else expect(await response.text()).toContain("ページが見つかりません");
    }
  }
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
