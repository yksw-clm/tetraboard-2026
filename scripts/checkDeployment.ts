import { healthzContract, listRoomsContract } from "../packages/protocol/src/index";
import { gameCatalog, gameIds } from "../packages/protocol/src/games";
import { lobbyCanonical, lobbyMetadata, publicOrigin } from "../apps/web/src/seo/lobbyMetadata";

const origin = process.argv[2];
if (!origin) throw new Error("Usage: bun scripts/checkDeployment.ts <origin>");
const base = new URL(origin);
if (!["http:", "https:"].includes(base.protocol)) throw new Error("Expected an HTTP(S) URL");

async function check(
  path: string,
  validate: (response: Response) => Promise<void>,
  redirect: RequestRedirect = "follow",
) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(new URL(path, base), {
        signal: AbortSignal.timeout(10_000),
        headers: { "Cache-Control": "no-cache" },
        redirect,
      });
      if (!response.ok && !(redirect === "manual" && response.status === 308))
        throw new Error(`HTTP ${response.status}`);
      await validate(response);
      console.log(`OK ${path}`);
      return;
    } catch (error) {
      if (attempt === 5) throw new Error(`Deployment check failed: ${path}`, { cause: error });
      await Bun.sleep(2_000);
    }
  }
}

await check(
  "/?seo-check=1",
  async (response) => {
    if (
      response.status !== 308 ||
      response.headers.get("Location") !==
        new URL(`${gameCatalog["four-reversi"].lobbyPath}?seo-check=1`, base).toString()
    )
      throw new Error("Expected root redirect with query");
  },
  "manual",
);
for (const game of gameIds) {
  await check(gameCatalog[game].lobbyPath, async (response) => {
    if (!response.headers.get("content-type")?.includes("text/html"))
      throw new Error("Expected HTML");
    if (response.headers.get("X-Robots-Tag")?.includes("noindex"))
      throw new Error("Public lobby is noindex");
    const html = await response.text();
    for (const expected of [
      `<title>${lobbyMetadata[game].title}</title>`,
      `href="${lobbyCanonical(game)}"`,
      'content="index,follow"',
      'name="description"',
      `data-public-lobby="${game}"`,
      lobbyMetadata[game].overview,
      'href="/games/four-reversi"',
      'href="/games/four-shogi"',
      'href="/games/reversi"',
    ])
      if (!html.includes(expected)) throw new Error(`Missing lobby content: ${expected}`);
  });
}
await check("/robots.txt", async (response) => {
  if (!response.headers.get("content-type")?.includes("text/plain"))
    throw new Error("Expected robots text");
  const text = await response.text();
  if (
    !text.includes("User-agent: *") ||
    !text.includes("Allow: /") ||
    !text.includes(`Sitemap: ${publicOrigin}/sitemap.xml`)
  )
    throw new Error("Invalid robots.txt");
});
await check("/sitemap.xml", async (response) => {
  if (!response.headers.get("content-type")?.includes("xml"))
    throw new Error("Expected sitemap XML");
  const text = await response.text();
  if (
    !text.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"') ||
    (text.match(/<loc>/g) ?? []).length !== gameIds.length ||
    !gameIds.every((game) => text.includes(`<loc>${lobbyCanonical(game)}</loc>`))
  )
    throw new Error("Invalid sitemap URLs");
});
await check("/api/healthz", async (response) => {
  healthzContract.response.parse(await response.json());
});
await check("/api/rooms", async (response) => {
  listRoomsContract.response.parse(await response.json());
});
