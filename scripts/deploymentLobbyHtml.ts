import { gameCatalog, type GameId } from "../packages/protocol/src/games";
import { lobbyMetadata } from "../apps/web/src/seo/lobbyMetadata";

export function validateDeploymentLobbyHtml(
  html: string,
  game: GameId,
  { publicOrigin, searchIndexable }: { publicOrigin: string; searchIndexable: boolean },
): void {
  for (const expected of [
    `<title>${lobbyMetadata[game].title}</title>`,
    `href="${publicOrigin}${gameCatalog[game].lobbyPath}"`,
    `content="${searchIndexable ? "index,follow" : "noindex,follow"}"`,
    'name="description"',
    `data-public-lobby="${game}"`,
    lobbyMetadata[game].overview,
  ])
    if (!html.includes(expected)) throw new Error(`Missing lobby content: ${expected}`);

  const navigation = html.match(
    /<nav\b[^>]*aria-label="メインナビゲーション"[^>]*>([\s\S]*?)<\/nav>/,
  )?.[1];
  if (!navigation) throw new Error("Missing lobby navigation");
  for (const path of ["/", "/how-to-play", gameCatalog[game].lobbyPath]) {
    const expected = `href="${path}"`;
    if (!navigation.includes(expected)) throw new Error(`Missing lobby navigation: ${expected}`);
  }
}
