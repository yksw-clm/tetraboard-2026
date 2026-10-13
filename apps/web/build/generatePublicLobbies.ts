import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import {
  renderGeneralLobby,
  renderPublicLobby,
  renderNotFound,
  renderSitemap,
  robotsText,
} from "./renderPublicLobby";

const dist = new URL("../dist/", import.meta.url);
const template = await readFile(new URL("index.html", dist), "utf8");
// 元のVite出力を使い、ハッシュ付きのJS・CSS参照を保持する。
for (const match of template.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g))
  await access(new URL(match[1]!.slice(1), dist));
for (const game of gameIds) {
  const directory = new URL(`${gameCatalog[game].lobbyPath.slice(1)}/`, dist);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("index.html", directory), renderPublicLobby(template, game));
}
await writeFile(new URL("404.html", dist), renderNotFound(template));
await writeFile(
  new URL("app.html", dist),
  template.replace("</head>", '<meta name="robots" content="noindex,follow" /></head>'),
);
await writeFile(new URL("index.html", dist), renderGeneralLobby(template));
await writeFile(new URL("robots.txt", dist), robotsText);
await writeFile(new URL("sitemap.xml", dist), renderSitemap());
console.info(
  `Generated general lobby and ${gameIds.length} game lobbies, robots.txt, sitemap.xml and 404.html`,
);
