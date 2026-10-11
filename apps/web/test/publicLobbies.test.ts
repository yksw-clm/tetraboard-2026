import { expect, test } from "bun:test";
import {
  renderPublicLobby,
  renderNotFound,
  renderSitemap,
  robotsText,
  escapeHtml,
} from "../build/renderPublicLobby";

const template =
  '<!doctype html><html lang="ja"><head><title>Tetra Board</title><script src="/assets/app-123.js"></script><link rel="stylesheet" href="/assets/app-123.css"></head><body><div id="root"></div></body></html>';

test("四人ゲームの初期HTMLは固有本文・正規URL・描画資産と通常リンクを持つ", () => {
  for (const [game, name, detail] of [
    ["four-reversi", "四人リバーシ", "全滅手は禁止"],
    ["four-shogi", "四人将棋", "三人攻撃禁止は初期値ON"],
    ["four-gomoku", "四人五目並べ", "味方2色が混ざった五連"],
  ] as const) {
    const html = renderPublicLobby(template, game);
    expect(html).toContain(`<title>TetraBoard | ${name}をブラウザでオンライン対戦</title>`);
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

test("サイトマップは6ロビーだけ、robotsはクロールを許可し404は検索除外する", () => {
  const xml = renderSitemap();
  expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  expect(xml.match(/<loc>/g)).toHaveLength(6);
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
