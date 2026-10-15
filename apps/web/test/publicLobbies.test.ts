import { expect, test } from "bun:test";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { generalLobbyMetadata, lobbyMetadata } from "../src/seo/lobbyMetadata";
import {
  renderPublicLobby,
  renderGeneralLobby,
  renderNotFound,
  renderSitemap,
  robotsText,
  escapeHtml,
} from "../build/renderPublicLobby";

const template =
  '<!doctype html><html lang="ja"><head><title>TetraBoard</title><meta property="og:site_name" content="TetraBoard" /><script src="/assets/app-123.js"></script><link rel="stylesheet" href="/assets/app-123.css"></head><body><div id="root"></div></body></html>';

test("既定HTMLと全公開ロビーはブランド表記とゲーム別titleの語順をそろえる", async () => {
  const source = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(source).toContain("<title>TetraBoard</title>");
  for (const html of [
    source,
    renderGeneralLobby(source),
    ...gameIds.map((game) => renderPublicLobby(source, game)),
  ]) {
    expect(html).not.toContain("Tetra Board");
    expect(html.match(/property="og:site_name" content="TetraBoard"/g)).toHaveLength(1);
  }
  for (const game of gameIds) {
    const html = renderPublicLobby(template, game);
    const { title, description } = lobbyMetadata[game];
    expect(title).toStartWith(gameCatalog[game].name);
    expect(title).toEndWith("をブラウザで無料対戦 | TetraBoard");
    expect(
      [...title].reduce((width, char) => width + (char.charCodeAt(0) < 128 ? 0.5 : 1), 0),
    ).toBeLessThanOrEqual(33);
    expect(description.length).toBeLessThanOrEqual(120);
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(`name="description" content="${description}"`);
  }
});

test("四人ゲームの初期HTMLは固有本文・正規URL・描画資産と通常リンクを持つ", () => {
  for (const [game, keyword, detail] of [
    ["four-reversi", "4人オセロ", "全滅手は禁止"],
    ["four-shogi", "4人将棋", "三人攻撃禁止は初期値ON"],
    ["four-gomoku", "四人五目並べ", "味方2色が混ざった五連"],
  ] as const) {
    const html = renderPublicLobby(template, game);
    expect(html.match(/<title>(.*?)<\/title>/)?.[1]).toContain(keyword);
    expect(lobbyMetadata[game].description).toContain(keyword);
    expect(lobbyMetadata[game].overview.split(keyword)).toHaveLength(2);
    expect(html).toContain(`href="https://tetraboard.net/games/${game}"`);
    expect(html).toContain('name="description"');
    expect(html).toContain('content="index,follow"');
    expect(html).toContain(detail);
    expect(html).toContain("CPU3人との待機室");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('href="/games/four-reversi"');
    expect(html).toContain('href="/games/four-shogi"');
    expect(html).toContain('src="/assets/app-123.js"');
    expect(html).toContain('href="/assets/app-123.css"');
    expect(html).not.toContain("noindex");
  }
});

test("サイトマップは総合と6ゲームのロビー、robotsはクロールを許可し404は検索除外する", () => {
  const xml = renderSitemap();
  expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  expect(xml.match(/<loc>/g)).toHaveLength(7);
  expect(xml.match(/<lastmod>/g)).toHaveLength(7);
  for (const [url, lastModified] of [
    ["https://tetraboard.net/", generalLobbyMetadata.lastModified],
    ...gameIds.map((game) => [
      `https://tetraboard.net${gameCatalog[game].lobbyPath}`,
      lobbyMetadata[game].lastModified,
    ]),
  ]) {
    expect(lastModified!).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(lastModified!).toISOString().slice(0, 10)).toBe(lastModified);
    expect(xml).toContain(`<url><loc>${url}</loc><lastmod>${lastModified}</lastmod></url>`);
  }
  expect(xml).toContain("https://tetraboard.net/games/four-shogi</loc>");
  expect(xml).toContain("https://tetraboard.net/games/four-reversi</loc>");
  expect(robotsText).toContain("Allow: /\nSitemap: https://tetraboard.net/sitemap.xml");
  const html = renderNotFound(template);
  expect(html).toContain("ページが見つかりません。");
  expect(html).toContain('content="noindex,follow"');
  expect(html).toContain('href="/games/four-shogi"');
});

test("メタ情報の特殊文字をエスケープし、不正な生成テンプレートを拒否する", () => {
  expect(escapeHtml('<script title="A&B">')).toBe("&lt;script title=&quot;A&amp;B&quot;&gt;");
  expect(() => renderPublicLobby("<html></html>", "four-shogi")).toThrow("template markers");
});

test("総合ロビーの初期HTMLは全ゲームへの入口と正規URLを持つ", () => {
  const html = renderGeneralLobby(template);
  expect(html).toContain('data-public-lobby="all"');
  expect(html).toContain('href="https://tetraboard.net/"');
  expect(html).toContain("総合ロビー");
  expect(html).not.toContain("chat-1");
});
