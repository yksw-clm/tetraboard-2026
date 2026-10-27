import { appThemeClasses, gameThemes } from "../src/shared/ui/appTheme";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultGameId, gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { GameIntroduction } from "../src/seo/GameIntroduction";
import { AppIcon } from "../src/shared/ui/AppIcon";
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

// eslint-disable-next-line react/only-export-components -- 静的HTMLの生成にだけ使用します。
function InitialNavigation({
  game = defaultGameId,
  home = false,
  boardSources,
}: {
  game?: GameId;
  home?: boolean;
  boardSources: LobbyBoardSources;
}) {
  return (
    <header className="border-b border-solid border-line bg-[#f9fbfa]">
      <div className="mx-auto flex max-w-[1148px] flex-wrap items-center gap-5 px-5 py-3">
        <a
          href="/"
          className="inline-flex items-center gap-3 text-2xl font-bold text-ink no-underline"
        >
          <img src="/favicon.ico" width="32" height="32" alt="" />
          TetraBoard
        </a>
        <nav
          aria-label="メインナビゲーション"
          className="flex items-center gap-5 text-sm font-bold"
        >
          <a
            href="/"
            aria-current={home ? "page" : undefined}
            className="inline-flex min-h-11 items-center gap-2 text-brand no-underline"
          >
            <AppIcon name="home" />
            ホーム
          </a>
          <a
            href="/how-to-play"
            className="inline-flex min-h-11 items-center gap-2 text-muted no-underline"
          >
            <AppIcon name="book" />
            遊び方
          </a>
          <a
            href={gameCatalog[game].lobbyPath}
            aria-current={home ? undefined : "page"}
            className="inline-flex min-h-11 items-center gap-2 text-brand no-underline"
          >
            <span className="grid size-6 place-items-center [&_img]:w-5 [&_img]:max-h-6 [&_img]:object-contain [&_img]:rotate-0 [&_img]:shadow-none">
              <LobbyBoardPreview game={game} src={boardSources[game]} compact />
            </span>
            {gameCatalog[game].name}
          </a>
        </nav>
      </div>
    </header>
  );
}

export function renderPublicLobby(
  template: string,
  game: GameId,
  boardSources: LobbyBoardSources,
): string {
  if (!template.includes('<div id="root"></div>') || !/<title>.*?<\/title>/.test(template))
    throw new Error("Missing public lobby template markers");
  const page = lobbyMetadata[game];
  const body = renderToStaticMarkup(
    <div
      className={`app-theme lobby-background min-h-dvh text-ink ${appThemeClasses[gameThemes[game]]}`}
    >
      <InitialNavigation game={game} boardSources={boardSources} />
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
  const metadata = `<title>${escapeHtml(page.title)}</title><meta name="description" content="${escapeHtml(page.description)}" /><meta name="robots" content="${searchIndexable ? "index,follow" : "noindex,follow"}" /><link rel="canonical" href="${lobbyCanonical(game)}" />`;
  return template
    .replace(/<title>.*?<\/title>/, metadata)
    .replace('<div id="root"></div>', `<div id="root" data-public-lobby="${game}">${body}</div>`);
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
          <main>
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
      <InitialNavigation home boardSources={boardSources} />
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
  return template
    .replace(
      /<title>.*?<\/title>/,
      `<title>${escapeHtml(generalLobbyMetadata.title)}</title><meta name="description" content="${escapeHtml(generalLobbyMetadata.description)}" /><meta name="robots" content="${searchIndexable ? "index,follow" : "noindex,follow"}" /><link rel="canonical" href="${publicOrigin}/" />`,
    )
    .replace('<div id="root"></div>', `<div id="root" data-public-lobby="all">${body}</div>`);
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
      ]
    : [];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map(({ url, lastModified }) => `<url><loc>${escapeHtml(url)}</loc><lastmod>${escapeHtml(lastModified)}</lastmod></url>`).join("")}</urlset>\n`;
}
