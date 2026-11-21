import {
  healthzContract,
  listRoomsContract,
  tournamentLobbySchema,
  tournamentDetailSchema,
} from "../packages/protocol/src/index";
import { gameCatalog, gameIds } from "../packages/protocol/src/games";
import { generalLobbyMetadata, lobbyMetadata } from "../apps/web/src/seo/lobbyMetadata";
import { formationCatalog } from "../packages/four-shogi/src/formationCatalog";
import { validateDeploymentLobbyHtml } from "./deploymentLobbyHtml";

const origin = process.argv[2];
if (!origin) throw new Error("Usage: bun scripts/checkDeployment.ts <origin>");
const base = new URL(origin);
const environment = process.argv[3] ?? "production";
if (!["production", "development"].includes(environment)) throw new Error("Unknown environment");
const searchIndexable = environment === "production";
const tournamentIndexable = base.origin === "https://tetraboard.net";
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

if (searchIndexable && base.origin === publicOrigin) {
  for (const path of [
    "/?seo-check=1",
    "/games/four-shogi?seo-check=1",
    "/api/healthz?seo-check=1",
  ]) {
    await check(
      `http://${base.host}${path}`,
      async (response) => {
        if (
          response.status !== 308 ||
          response.headers.get("Location") !== `${publicOrigin}${path}`
        )
          throw new Error("Expected permanent redirect to production HTTPS");
      },
      "manual",
    );
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
    validateDeploymentLobbyHtml(html, game, { publicOrigin, searchIndexable });
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
  if (!text.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'))
    throw new Error("Invalid sitemap XML namespace");

  const locations = [...text.matchAll(/<loc>([^<]*)<\/loc>/g)].map(([, url]) => url!);
  if ((text.match(/<loc>/g) ?? []).length !== locations.length)
    throw new Error("Malformed sitemap URL");
  if (!searchIndexable) {
    if (locations.length || text.includes("<lastmod>")) throw new Error("Invalid sitemap URLs");
    return;
  }

  const lobbies = new Map([
    [`${publicOrigin}/`, generalLobbyMetadata.lastModified],
    ...gameIds.map((game) => [lobbyCanonical(game), lobbyMetadata[game].lastModified] as const),
  ]);
  const tournamentList = `${publicOrigin}/tournaments`;
  const detailPrefix = `${tournamentList}/`;
  if (
    (tournamentIndexable
      ? !locations.includes(tournamentList)
      : locations.length !== lobbies.size) ||
    [...lobbies].some(
      ([url, lastmod]) => !text.includes(`<loc>${url}</loc><lastmod>${lastmod}</lastmod>`),
    ) ||
    locations.some(
      (url) =>
        !lobbies.has(url) &&
        (!tournamentIndexable ||
          (url !== tournamentList &&
            !(url.startsWith(detailPrefix) && /^[1-9]\d*$/.test(url.slice(detailPrefix.length))))),
    )
  )
    throw new Error("Invalid sitemap URLs");
});
await check("/tournaments", async (response) => {
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html"))
    throw new Error("Expected tournament list HTML");
  const html = await response.text();
  const robots = tournamentIndexable ? "index,follow" : "noindex,follow";
  if (
    !html.includes(`<meta name="robots" content="${robots}">`) ||
    !html.includes("<h1>大会一覧</h1>")
  )
    throw new Error("Missing tournament list heading or expected robots metadata");
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

let tournamentId: number | undefined;
await check("/api/tournaments/lobby", async (response) => {
  tournamentId = tournamentLobbySchema.parse(await response.json()).tournament?.id;
});
if (tournamentId !== undefined) {
  const started = performance.now();
  await check(`/api/tournaments/${tournamentId}`, async (response) => {
    tournamentDetailSchema.parse(await response.json());
  });
  console.log(`Tournament detail: ${Math.round(performance.now() - started)}ms`);
}
