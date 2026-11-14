import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { gameIds } from "@tetraboard/protocol/games";
import worker from "../src/worker";
import { isBrowserUserAgent } from "../src/usageEvents/visit";
import { recordUsageEvents } from "./usageEventsRecorder";

const browserUserAgents = [
  {
    browser: "Chrome / Windows",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  },
  {
    browser: "Chrome / Android",
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  },
  {
    browser: "Chrome / iPhone",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
  },
  {
    browser: "Safari / Mac",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  },
  {
    browser: "Safari / iPhone",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  {
    browser: "Safari / iPad",
    ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  {
    browser: "Firefox / Windows",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  },
  {
    browser: "Firefox / Android",
    ua: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
  },
  {
    browser: "Firefox / iPhone",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
  },
  {
    browser: "Edge / Windows",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  },
  {
    browser: "Edge / Android",
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0",
  },
  {
    browser: "Edge / iPhone",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0.0.0 Mobile/15E148 Safari/605.1.15",
  },
];
const browserUa = browserUserAgents[0]!.ua;
const excludedUserAgents = [
  null,
  "",
  "   ",
  "curl/8.7.1",
  "Wget/1.21",
  "python-requests/2.31",
  "Bun/1.4.4",
  "Go-http-client/1.1",
  "Googlebot",
  "bingbot",
  "Twitterbot/1.0",
  "SomeCrawler",
  "SPIDER",
  "robot",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 SomeCrawler",
  "Mozilla/5.0 SPIDER",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 HEADLESS",
];

test.each(browserUserAgents)("$browser のUAをブラウザと判定する", ({ ua }) => {
  expect(isBrowserUserAgent(ua)).toBe(true);
});

test.each(excludedUserAgents)("ブラウザ以外のUA %s を除外する", (ua) => {
  expect(isBrowserUserAgent(ua)).toBe(false);
});

const cookieName = "tetraboard-2026.analytics";
const browserId = "01234567-89ab-4cde-8fab-0123456789ab";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const body =
  '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>';
const cacheControl = "public, max-age=0, must-revalidate";

function pageFixture(options: { status?: number; headers?: HeadersInit; origin?: string } = {}) {
  const origin = options.origin ?? "https://tetraboard.net";
  const databaseRead = vi.fn(() => {
    throw new Error("HTML must not read D1");
  });
  const assets = {
    async fetch(request: Request) {
      const headers = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": cacheControl,
        ETag: '"fixture"',
      });
      for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
      const status = options.status ?? 200;
      return new Response(
        request.method === "HEAD" || status === 204 || status === 304 ? null : body,
        { status, headers },
      );
    },
  } as Fetcher;
  return {
    databaseRead,
    fetch: (path: string, init?: RequestInit) =>
      worker.fetch(
        new Request(`${origin}${path}`, init),
        {
          ...env,
          APP_ORIGIN: origin as Env["APP_ORIGIN"],
          APP_DB: { prepare: databaseRead } as unknown as D1Database,
          ASSETS: assets,
          USAGE_EVENTS: { writeDataPoint() {} } as unknown as AnalyticsEngineDataset,
        },
        {} as ExecutionContext,
      ),
  };
}

test.each(browserUserAgents)("$browser のHTML取得は訪問とCookieを作る", async ({ ua }) => {
  const events = recordUsageEvents();
  const response = await pageFixture().fetch("/", { headers: { "User-Agent": ua } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(body);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ name: "visit_started", page: "general-lobby" });
  expect(response.headers.get("Set-Cookie")).toContain(`${cookieName}=${events[0]!.browserId};`);
});

test.each([
  { path: "/", page: "general-lobby", game: null },
  ...gameIds.map((game) => ({ path: `/games/${game}`, page: "lobby", game })),
  { path: "/rooms/12345", page: "room", game: null },
  { path: "/matches/example", page: "replay", game: null },
  { path: "/account/matches/example", page: "replay", game: null },
  { path: "/account/setup", page: "setup", game: null },
  { path: "/login", page: "login", game: null },
  { path: "/account", page: "account", game: null },
  { path: "/feedback", page: "other", game: null },
])(
  "$path のHTMLはパスから分類した訪問を1点だけ書き、D1を読まない",
  async ({ path, page, game }) => {
    const events = recordUsageEvents();
    const fixture = pageFixture();
    const response = await fixture.fetch(
      `${path}?utm=1&utm_source= X /告知?&utm_medium=Social&utm_campaign=${"A".repeat(70)}&token=secret`,
      {
        headers: {
          Cookie: `unrelated=value; ${cookieName}=${browserId}; session=secret`,
          Referer: "https://WWW.Google.COM/search?q=secret#secret",
          "User-Agent": "Mozilla/5.0 (iPhone) Mobile",
          "CF-Connecting-IP": "192.0.2.1",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root"></div>');
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe(page === "room" ? "no-store" : cacheControl);
    expect(events).toEqual([
      {
        name: "visit_started",
        isTest: false,
        accountId: "",
        browserId,
        page,
        game,
        referrerClass: "search",
        referrerHost: "www.google.com",
        utmSource: "X",
        utmMedium: "Social",
        utmCampaign: "A".repeat(64),
        device: "smartphone",
      },
    ]);
    expect(fixture.databaseRead).not.toHaveBeenCalled();
  },
);

test.each([
  {
    referer: "https://t.co/secret?token=secret",
    ua: "Mozilla/5.0 (iPad) Mobile",
    referrerClass: "social",
    referrerHost: "t.co",
    device: "tablet",
  },
  {
    referer: "https://tetraboard.net/rooms/12345?invite=secret",
    ua: browserUa,
    referrerClass: "internal",
    referrerHost: "internal",
    device: "pc",
  },
  {
    referer: "https://example.org/path?secret=value",
    ua: "Mozilla/5.0 (Linux; Android 14)",
    referrerClass: "other",
    referrerHost: "example.org",
    device: "tablet",
  },
  {
    referer: "https://192.0.2.1/path",
    ua: "Mozilla/5.0",
    referrerClass: "",
    referrerHost: null,
    device: "pc",
  },
  { referer: "", ua: browserUa, referrerClass: "direct", referrerHost: "direct", device: "pc" },
])(
  "参照元とUAを最小限の分類へ落とす: $referrerClass / $device",
  async ({ referer, ua, ...expected }) => {
    const events = recordUsageEvents();
    await pageFixture().fetch("/rooms/12345?utm=1&utm_source=日本語&utm_medium=%20&utm_campaign=", {
      headers: { ...(referer ? { Referer: referer } : {}), "User-Agent": ua },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ...expected,
      page: "room",
      game: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
    });
  },
);

test.each([
  undefined,
  "",
  "not-a-uuid",
  "01234567-89ab-1cde-8fab-0123456789ab",
  "01234567-89ab-4cde-7fab-0123456789ab",
  `${browserId}extra`,
  `"${browserId}"`,
])(
  "Cookieが未発行またはUUID v4でなければ新しいIDを応答とイベントで共有する: %s",
  async (cookie) => {
    const events = recordUsageEvents();
    const response = await pageFixture().fetch("/", {
      headers: {
        "User-Agent": browserUa,
        ...(cookie === undefined ? {} : { Cookie: `${cookieName}=${cookie}` }),
      },
    });
    const issued = response.headers.get("Set-Cookie")!;
    const id = issued.split(";")[0]!.slice(cookieName.length + 1);
    expect(id).toMatch(uuidV4);
    expect(issued).toBe(`${cookieName}=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    expect(events).toHaveLength(1);
    expect(events[0]!.browserId).toBe(id);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("ETag")).toBe('"fixture"');
    expect(await response.text()).toBe(body);
  },
);

test("HTTPのCookieにSecureを付けず、発行済みの大文字UUIDもそのまま再利用する", async () => {
  const events = recordUsageEvents();
  const fixture = pageFixture({ origin: "http://localhost:5173" });
  const first = await fixture.fetch("/", { headers: { "User-Agent": browserUa } });
  expect(first.headers.get("Set-Cookie")).toBe(
    `${cookieName}=${events[0]!.browserId}; Path=/; Max-Age=31536000; SameSite=Lax`,
  );
  const existing = browserId.toUpperCase();
  const second = await fixture.fetch("/", {
    headers: { "User-Agent": browserUa, Cookie: `${cookieName}=${existing}` },
  });
  expect(events[1]!.browserId).toBe(existing);
  expect(second.headers.get("Set-Cookie")).toBeNull();
  expect(second.headers.get("Cache-Control")).toBe(cacheControl);
});

test.each([
  ["public, max-age=0, must-revalidate", "private, max-age=0, must-revalidate"],
  ["no-store", "private, no-store"],
  ["private, no-cache", "private, no-cache"],
  ["Public, max-age=30, must-revalidate", "private, max-age=30, must-revalidate"],
  ["", "private"],
])("Cookie発行時も既存のキャッシュ制約と他のCookieを保つ: %s", async (before, after) => {
  recordUsageEvents();
  const response = await pageFixture({
    headers: { "Cache-Control": before!, "Set-Cookie": "other=value; Path=/" },
  }).fetch("/", { headers: { "User-Agent": browserUa } });
  expect(response.headers.get("Cache-Control")).toBe(after);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(response.headers.getSetCookie()[0]).toBe("other=value; Path=/");
});

test.each([
  { path: "/privacy" },
  { path: "/terms" },
  { path: "/admin" },
  { path: "/admin/settings" },
  { path: "/api/missing" },
  { path: "/api" },
  { path: "/assets/app.js" },
  { path: "/assets/app.css" },
  { path: "/assets/image.png" },
  { path: "/assets/page.html" },
  { path: "/four-shogi/formations/example.jpg" },
  { path: "/robots.txt" },
  { path: "/sitemap.xml" },
  { path: "/unknown" },
  { path: "/index.html" },
  { path: "/games/four-shogi/" },
  { path: "/profile" },
  { path: "/", method: "HEAD" },
  { path: "/rooms/12345", method: "HEAD" },
  { path: "/", method: "POST" },
  { path: "/", headers: { Upgrade: "websocket" } },
])("対象外の $path / $method は訪問もCookieも作らない", async ({ path, ...init }) => {
  const events = recordUsageEvents();
  const response = await pageFixture().fetch(path, {
    ...init,
    headers: { "User-Agent": browserUa, ...init.headers },
  });
  expect(events).toEqual([]);
  expect(response.headers.get("Set-Cookie")).toBeNull();
});

test.each(excludedUserAgents)(
  "ブラウザ以外のUA %s の成功HTMLでも訪問とCookieを作らない",
  async (ua) => {
    const events = recordUsageEvents();
    const response = await pageFixture().fetch("/", {
      headers: ua === null ? {} : { "User-Agent": ua },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(events).toEqual([]);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe(cacheControl);
  },
);

test.each([301, 302, 304, 404, 500, 503])(
  "アセットが%sを返したら訪問とCookieを作らない",
  async (status) => {
    const events = recordUsageEvents();
    const response = await pageFixture({ status }).fetch("/games/four-shogi", {
      headers: { "User-Agent": browserUa },
    });
    expect(response.status).toBe(status);
    expect(events).toEqual([]);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  },
);

test("画面URLでもHTML以外の応答は記録しない", async () => {
  const events = recordUsageEvents();
  const response = await pageFixture({ headers: { "Content-Type": "text/plain" } }).fetch("/", {
    headers: { "User-Agent": browserUa },
  });
  expect(response.status).toBe(200);
  expect(events).toEqual([]);
  expect(response.headers.get("Set-Cookie")).toBeNull();
});

test("書き込み失敗でもHTMLとCookieを返す", async () => {
  const events = recordUsageEvents(true);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const response = await pageFixture().fetch("/", { headers: { "User-Agent": browserUa } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(body);
  expect(response.headers.get("Set-Cookie")).toContain(events[0]!.browserId);
  expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
  expect(events).toHaveLength(1);
  expect(warn.mock.calls).toEqual([["Usage event write failed"]]);
});
