import { appThemeClasses, gameThemes } from "../src/shared/ui/appTheme";
import { renderToStaticMarkup } from "react-dom/server";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { GameIntroduction } from "../src/seo/GameIntroduction";
import {
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

export function renderPublicLobby(template: string, game: GameId): string {
  if (!template.includes('<div id="root"></div>') || !/<title>.*?<\/title>/.test(template))
    throw new Error("Missing public lobby template markers");
  const page = lobbyMetadata[game];
  const body = renderToStaticMarkup(
    <div
      className={`app-theme lobby-background min-h-dvh text-ink ${appThemeClasses[gameThemes[game]]}`}
    >
      <main className="max-w-[1148px] mx-auto px-5 py-6 flex flex-col gap-5">
        <nav aria-label="ゲームを選択" className="flex gap-5">
          {gameIds.map((id) => (
            <a
              key={id}
              href={gameCatalog[id].lobbyPath}
              className="text-brand underline min-h-11 inline-flex items-center"
              aria-current={id === game ? "page" : undefined}
            >
              {gameCatalog[id].name}
            </a>
          ))}
        </nav>
        <h1 className="text-3xl font-bold">{gameCatalog[game].name}</h1>
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

export const robotsText = `User-agent: *\nAllow: /\n${searchIndexable ? `Sitemap: ${publicOrigin}/sitemap.xml\n` : ""}`;
export function renderSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${(searchIndexable ? gameIds : []).map((game) => `<url><loc>${lobbyCanonical(game)}</loc></url>`).join("")}</urlset>\n`;
}
