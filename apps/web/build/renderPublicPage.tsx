import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import {
  GameIntroduction,
  PublicGameNavigation,
  PublicRulesContent,
} from "../src/publicPages/PublicContent";
import {
  publicOrigin,
  publicPages,
  gameIntroductions,
  type PublicPageKind,
} from "../src/publicPages/catalog";
import { readPublicRules } from "./readPublicRules";
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
export async function renderPublicPage(
  template: string,
  game: GameId,
  kind: PublicPageKind,
): Promise<string> {
  const page = publicPages[game][kind];
  const url = `${publicOrigin}${page.path}`;
  const content =
    kind === "rules" ? (
      <PublicRulesContent game={game} content={await readPublicRules(game)} />
    ) : (
      <main className="max-w-[1148px] mx-auto px-5 py-6">
        <PublicGameNavigation />
        <h1 className="text-3xl font-bold my-6">{gameCatalog[game].name}</h1>
        <p className="my-4">{gameIntroductions[game].short}</p>
        <GameIntroduction game={game} />
      </main>
    );
  const head = `<title>${escape(page.title)}</title><meta name="description" content="${escape(page.description)}" /><meta name="robots" content="index,follow" /><link rel="canonical" href="${url}" /><meta property="og:title" content="${escape(page.title)}" /><meta property="og:description" content="${escape(page.description)}" /><meta property="og:url" content="${url}" /><meta property="og:type" content="website" /><meta property="og:site_name" content="TetraBoard" /><meta property="og:locale" content="ja_JP" />`;
  return template
    .replace(/<title>[\s\S]*?<\/title>/, head)
    .replace('<div id="root"></div>', `<div id="root">${renderToStaticMarkup(content)}</div>`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [game, kind] = process.argv.slice(2);
  if ((game !== "four-reversi" && game !== "four-shogi") || (kind !== "lobby" && kind !== "rules"))
    throw new Error("未知の公開ページ");
  console.log(
    await renderPublicPage(
      await readFile(new URL("../index.html", import.meta.url), "utf8"),
      game,
      kind,
    ),
  );
}
