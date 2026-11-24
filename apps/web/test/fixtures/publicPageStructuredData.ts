import { expect } from "bun:test";
import { fourShogiRulesPath, gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";

export function readJsonLd(html: string): unknown {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  expect(html.match(/<head>([\s\S]*?)<\/head>/)?.[1]).toContain(scripts[0]![0]);
  return JSON.parse(scripts[0]![1]!);
}

export function expectPublicPageStructuredData(
  origin: string,
  home: string,
  lobbies: Record<GameId, string>,
  rules: string,
): void {
  expect(readJsonLd(home)).toEqual({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "TetraBoard",
    url: `${origin}/`,
  });
  const homeItem = { "@type": "ListItem", position: 1, name: "ホーム", item: `${origin}/` };
  for (const game of gameIds) {
    expect(readJsonLd(lobbies[game])).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        homeItem,
        {
          "@type": "ListItem",
          position: 2,
          name: gameCatalog[game].name,
          item: `${origin}${gameCatalog[game].lobbyPath}`,
        },
      ],
    });
  }
  expect(readJsonLd(rules)).toEqual({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      homeItem,
      { "@type": "ListItem", position: 2, name: "四人将棋", item: `${origin}/games/four-shogi` },
      { "@type": "ListItem", position: 3, name: "ルール", item: `${origin}${fourShogiRulesPath}` },
    ],
  });
}
