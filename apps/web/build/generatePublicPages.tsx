import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gameIds } from "@tetraboard/protocol/games";
import { publicOrigin, publicPages } from "../src/publicPages/catalog";
import { renderPublicPage } from "./renderPublicPage";

const dist = new URL("../dist/", import.meta.url);
const template = await readFile(new URL("index.html", dist), "utf8");
for (const game of gameIds) {
  for (const kind of ["lobby", "rules"] as const) {
    const page = publicPages[game][kind];
    const html = await renderPublicPage(template, game, kind);
    const directory = new URL(`${page.path.slice(1)}/`, dist);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL("index.html", directory), html);
  }
}
await writeFile(
  new URL("index.html", dist),
  template.replace("</head>", '<meta name="robots" content="noindex,follow" /></head>'),
);
await writeFile(
  new URL("404.html", dist),
  template
    .replace("</head>", '<meta name="robots" content="noindex,follow" /></head>')
    .replace(
      '<div id="root"></div>',
      '<div id="root"><h1>ページが見つかりません。</h1><a href="/games/four-reversi">四人リバーシ</a><a href="/games/four-shogi">四人将棋</a></div>',
    ),
);
await writeFile(
  new URL("robots.txt", dist),
  `User-agent: *\nAllow: /\nSitemap: ${publicOrigin}/sitemap.xml\n`,
);
await writeFile(
  new URL("sitemap.xml", dist),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${gameIds.flatMap((game) => (["lobby", "rules"] as const).map((kind) => `<url><loc>${publicOrigin}${publicPages[game][kind].path}</loc></url>`)).join("")}</urlset>`,
);
console.info("Generated four public pages, robots.txt, sitemap.xml and 404.html");
