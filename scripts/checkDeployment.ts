import { healthzContract, listRoomsContract } from "../packages/protocol/src/index";
import { gameCatalog, gameIds } from "../packages/protocol/src/games";
import { lobbyMetadata, generalLobbyMetadata } from "../apps/web/src/seo/lobbyMetadata";
import { formationCatalog } from "../packages/four-shogi/src/formationCatalog";

const origin = process.argv[2];
if (!origin) throw new Error("Usage: bun scripts/checkDeployment.ts <origin>");
const base = new URL(origin);
const environment = process.argv[3] ?? "production";
if (!["production", "development"].includes(environment)) throw new Error("Unknown environment");
const searchIndexable = environment === "production";
const publicOrigin = searchIndexable
  ? "https://tetraboard.net"
  : "https://tetraboard-dev.chaossi-lab.workers.dev";
const lobbyCanonical = (game: (typeof gameIds)[number]) =>
  `${publicOrigin}${gameCatalog[game].lobbyPath}`;
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
    if (response.status !== 200) throw new Error("Expected general lobby HTML");
    const html = await response.text();
    if (
      !html.includes(generalLobbyMetadata.title) ||
      !html.includes('data-public-lobby="all"') ||
      !html.includes(`href="${publicOrigin}/"`)
    )
      throw new Error("Missing general lobby metadata");
  },
  "manual",
);
for (const game of gameIds) {
  await check(gameCatalog[game].lobbyPath, async (response) => {
    if (!response.headers.get("content-type")?.includes("text/html"))
      throw new Error("Expected HTML");
    if (Boolean(response.headers.get("X-Robots-Tag")?.includes("noindex")) === searchIndexable)
      throw new Error("Unexpected lobby indexing policy");
    const html = await response.text();
    for (const expected of [
      `<title>${lobbyMetadata[game].title}</title>`,
      `href="${lobbyCanonical(game)}"`,
      `content="${searchIndexable ? "index,follow" : "noindex,follow"}"`,
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
    (searchIndexable
      ? !text.includes(`Sitemap: ${publicOrigin}/sitemap.xml`)
      : text.includes("Sitemap:"))
  )
    throw new Error("Invalid robots.txt");
});
await check("/sitemap.xml", async (response) => {
  if (!response.headers.get("content-type")?.includes("xml"))
    throw new Error("Expected sitemap XML");
  const text = await response.text();
  if (
    !text.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"') ||
    (text.match(/<loc>/g) ?? []).length !== (searchIndexable ? gameIds.length + 1 : 0) ||
    (searchIndexable &&
      !gameIds.every((game) => text.includes(`<loc>${lobbyCanonical(game)}</loc>`)))
  )
    throw new Error("Invalid sitemap URLs");
});
await check("/api/healthz", async (response) => {
  healthzContract.response.parse(await response.json());
});
for (const { id } of formationCatalog) {
  await check(`/four-shogi/formations/${id}.jpg`, async (response) => {
    if (!response.headers.get("content-type")?.includes("image/jpeg"))
      throw new Error("Expected formation JPEG");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
      throw new Error("Invalid formation JPEG signature");
  });
}
await check("/api/rooms", async (response) => {
  listRoomsContract.response.parse(await response.json());
});
