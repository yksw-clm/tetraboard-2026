import { expect } from "bun:test";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";

export function readSocialTags(html: string) {
  return Array.from(
    html.matchAll(/<meta (property="og:[^"]+"|name="twitter:[^"]+") content="([^"]*)"/g),
    ([, attribute, content]) => [attribute, content],
  );
}

export function expectPublicPageSocialTags(
  html: string,
  { title, description }: { title: string; description: string },
  canonical: string,
  game?: GameId,
) {
  const image = `${new URL(canonical).origin}/assets/ogp/${game ?? "tetraboard"}.png`;
  const alt = game
    ? `${gameCatalog[game].name}の盤面とTetraBoardのロゴ`
    : "TetraBoardのロゴとボードゲームの盤面";
  expect(readSocialTags(html)).toEqual([
    ['property="og:title"', title],
    ['property="og:description"', description],
    ['property="og:type"', "website"],
    ['property="og:url"', canonical],
    ['property="og:image"', image],
    ['property="og:image:width"', "1200"],
    ['property="og:image:height"', "630"],
    ['property="og:image:alt"', alt],
    ['property="og:site_name"', "TetraBoard"],
    ['name="twitter:card"', "summary_large_image"],
    ['name="twitter:title"', title],
    ['name="twitter:description"', description],
    ['name="twitter:image"', image],
    ['name="twitter:image:alt"', alt],
  ]);
}
