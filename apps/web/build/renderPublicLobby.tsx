import type { RulesDiagramAssetResolver } from "../src/features/lobby/FourShogiRuleDiagrams";
import { fourShogiRulesMetadata } from "../src/seo/fourShogiRulesMetadata";
import { howToPlayMetadata, howToPlayPath } from "../src/seo/howToPlayMetadata";
import { HowToPlayPage } from "../src/features/help/HowToPlayPage";
import type { helpScreenshots } from "../src/features/help/helpScreenshots";
import { appThemeClasses, gameThemes } from "../src/shared/ui/appTheme";
import { renderToStaticMarkup } from "react-dom/server";
import { renderBreadcrumbJsonLd, renderWebSiteJsonLd } from "@tetraboard/protocol";
import {
  defaultGameId,
  fourShogiRulesPath,
  gameCatalog,
  gameIds,
  type GameId,
} from "@tetraboard/protocol/games";
import { openGraphTags } from "@tetraboard/protocol/room-sharing";
import { GameIntroduction } from "../src/seo/GameIntroduction";
import { InitialNavigation } from "../src/seo/InitialNavigation";
import { FourShogiRulesPage } from "../src/features/lobby/FourShogiRulesPage";
import { StaticRouter } from "react-router";
import { LobbyBoardPreview } from "../src/features/lobby/LobbyBoardPreview";
import type { LobbyBoardSources } from "./lobbyBoardAssets";
import {
  generalLobbyMetadata,
  lobbyCanonical,
  lobbyMetadata,
  publicOrigin,
  searchIndexable,
} from "../src/seo/lobbyMetadata";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderPublicPage(
  template: string,
  page: { title: string; description: string },
  canonical: string,
  marker: string,
  body: string,
  structuredData: string,
  game?: GameId,
): string {
  if (!template.includes('<div id="root"></div>') || !/<title>.*?<\/title>/.test(template))
    throw new Error("Missing public lobby template markers");
  const socialTags = openGraphTags(page, canonical, game)
    .map(({ kind, key, value }) => `<meta ${kind}="${key}" content="${escapeHtml(value)}" />`)
    .join("");
  const metadata = `<title>${escapeHtml(page.title)}</title><meta name="description" content="${escapeHtml(page.description)}" /><meta name="robots" content="${searchIndexable ? "index,follow" : "noindex,follow"}" /><link rel="canonical" href="${canonical}" />`;
  return template
    .replace(/<meta property="og:site_name"[^>]*>/g, "")
    .replace(/<title>.*?<\/title>/, () => metadata + socialTags + structuredData)
    .replace('<div id="root"></div>', `<div id="root" data-public-lobby="${marker}">${body}</div>`);
}

export function renderPublicLobby(
  template: string,
  game: GameId,
  boardSources: LobbyBoardSources,
): string {
  const body = renderToStaticMarkup(
    <div
      className={`app-theme lobby-background min-h-dvh text-ink ${appThemeClasses[gameThemes[game]]}`}
    >
      <InitialNavigation game={game} current="lobby" boardSrc={boardSources[game]} />
      <main className="max-w-[1148px] mx-auto px-5 py-6 flex flex-col gap-5">
        <div className="flex items-center gap-5">
          <span className="grid size-16 shrink-0 place-items-center">
            <LobbyBoardPreview game={game} src={boardSources[game]} compact className="!w-12" />
          </span>
          <h1 className="text-3xl font-bold">{gameCatalog[game].name}</h1>
        </div>
        <GameIntroduction game={game} />
        <p role="status" data-startup-status>
          対局画面を読み込んでいます…
        </p>
        <a data-startup-reload className="text-brand underline" href={gameCatalog[game].lobbyPath}>
          再読み込み
        </a>
        <noscript>対局するにはJavaScriptを有効にしてください。</noscript>
        <nav aria-label="規約とプライバシー">
          <a href="/terms">利用規約</a> <a href="/privacy">プライバシーポリシー</a>
        </nav>
      </main>
    </div>,
  );
  const canonical = lobbyCanonical(game);
  return renderPublicPage(
    template,
    lobbyMetadata[game],
    canonical,
    game,
    body,
    renderBreadcrumbJsonLd(`${publicOrigin}/`, { name: gameCatalog[game].name, url: canonical }),
    game,
  );
}

export function renderFourShogiRules(
  template: string,
  boardSources: LobbyBoardSources,
  resolveDiagramAsset: RulesDiagramAssetResolver,
): string {
  const body = renderToStaticMarkup(
    <StaticRouter location={fourShogiRulesPath}>
      <FourShogiRulesPage
        header={<InitialNavigation game="four-shogi" boardSrc={boardSources["four-shogi"]} />}
        resolveDiagramAsset={resolveDiagramAsset}
      />
    </StaticRouter>,
  );
  const canonical = `${publicOrigin}${fourShogiRulesPath}`;
  return renderPublicPage(
    template,
    fourShogiRulesMetadata,
    canonical,
    "four-shogi-rules",
    body,
    renderBreadcrumbJsonLd(
      `${publicOrigin}/`,
      { name: gameCatalog["four-shogi"].name, url: lobbyCanonical("four-shogi") },
      { name: "ルール", url: canonical },
    ),
    "four-shogi",
  );
}

export function renderHowToPlay(
  template: string,
  boardSources: LobbyBoardSources,
  screenshots: typeof helpScreenshots,
): string {
  const body = renderToStaticMarkup(
    <StaticRouter location={howToPlayPath}>
      <HowToPlayPage
        header={<InitialNavigation current="how-to-play" boardSrc={boardSources[defaultGameId]} />}
        screenshots={screenshots}
      />
    </StaticRouter>,
  );
  const canonical = `${publicOrigin}${howToPlayPath}`;
  return renderPublicPage(
    template,
    howToPlayMetadata,
    canonical,
    "how-to-play",
    body,
    renderBreadcrumbJsonLd(`${publicOrigin}/`, { name: "遊び方ガイド", url: canonical }),
  );
}

export function renderNotFound(template: string): string {
  return template
    .replace(
      /<title>.*?<\/title>/,
      '<title>ページが見つかりません | TetraBoard</title><meta name="robots" content="noindex,follow" />',
    )
    .replace(
      '<div id="root"></div>',
      renderToStaticMarkup(
        <div id="root">
          <main data-not-found="">
            <h1>ページが見つかりません。</h1>
            {gameIds.map((game) => (
              <p key={game}>
                <a href={gameCatalog[game].lobbyPath}>{gameCatalog[game].name}のロビーへ</a>
              </p>
            ))}
            <nav aria-label="規約とプライバシー">
              <a href="/terms">利用規約</a> <a href="/privacy">プライバシーポリシー</a>
            </nav>
          </main>
        </div>,
      ),
    );
}

export function renderGeneralLobby(template: string, boardSources: LobbyBoardSources): string {
  const body = renderToStaticMarkup(
    <div className="app-theme lobby-background min-h-dvh text-ink">
      <InitialNavigation current="home" boardSrc={boardSources[defaultGameId]} />
      <main className="max-w-[1148px] mx-auto px-5 py-6 flex flex-col gap-5">
        <h1>総合ロビー</h1>
        <p>{generalLobbyMetadata.description}</p>
        <nav aria-label="ゲーム一覧">
          {gameIds.map((game) => (
            <p key={game}>
              <a href={gameCatalog[game].lobbyPath}>{gameCatalog[game].name}</a>
            </p>
          ))}
        </nav>
        <p role="status" data-startup-status>
          ロビーを読み込んでいます…
        </p>
        <a data-startup-reload href="/">
          再読み込み
        </a>
        <noscript>参加・観戦するにはJavaScriptを有効にしてください。</noscript>
        <nav aria-label="規約とプライバシー">
          <a href="/terms">利用規約</a> <a href="/privacy">プライバシーポリシー</a>
        </nav>
      </main>
    </div>,
  );
  const canonical = `${publicOrigin}/`;
  return renderPublicPage(
    template,
    generalLobbyMetadata,
    canonical,
    "all",
    body,
    renderWebSiteJsonLd(canonical),
  );
}

export const robotsText = `User-agent: *\nAllow: /\n${searchIndexable ? `Sitemap: ${publicOrigin}/sitemap.xml\n` : ""}`;
export function renderSitemap(): string {
  const pages = searchIndexable
    ? [
        { url: `${publicOrigin}/`, lastModified: generalLobbyMetadata.lastModified },
        ...gameIds.map((game) => ({
          url: lobbyCanonical(game),
          lastModified: lobbyMetadata[game].lastModified,
        })),
        {
          url: `${publicOrigin}${fourShogiRulesPath}`,
          lastModified: fourShogiRulesMetadata.lastModified,
        },
        { url: `${publicOrigin}${howToPlayPath}`, lastModified: howToPlayMetadata.lastModified },
      ]
    : [];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(({ url, lastModified }) => `<url><loc>${escapeHtml(url)}</loc><lastmod>${escapeHtml(lastModified)}</lastmod></url>`).join("")}</urlset>\n`;
}
