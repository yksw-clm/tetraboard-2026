import { fourShogiRulesMetadata } from "../src/seo/fourShogiRulesMetadata";
import { expect, test } from "bun:test";
import { fourShogiRulesPath, gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { generalLobbyMetadata, lobbyMetadata } from "../src/seo/lobbyMetadata";
import { lobbyBoardSources, resolveRulesDiagramAsset } from "./fixtures/lobbyBoardSources";
import { expectPublicPageSocialTags } from "./fixtures/publicPageSocialTags";
import { expectPublicPageStructuredData } from "./fixtures/publicPageStructuredData";
import { lobbyBoardSourcesFromManifest } from "../build/lobbyBoardAssets";
import { validateDeploymentLobbyHtml } from "../../../scripts/deploymentLobbyHtml";
import {
  renderPublicLobby,
  renderFourShogiRules,
  renderGeneralLobby,
  renderNotFound,
  renderSitemap,
  robotsText,
  escapeHtml,
} from "../build/renderPublicLobby";

const template =
  '<!doctype html><html lang="ja"><head><title>TetraBoard</title><meta property="og:site_name" content="TetraBoard" /><script src="/assets/app-123.js"></script><link rel="stylesheet" href="/assets/app-123.css"></head><body><div id="root"></div></body></html>';

test("トップ・6ロビー・四人将棋のルールのheadに構造化データを1件ずつ出力する", () => {
  const lobbies = Object.fromEntries(
    gameIds.map((game) => [game, renderPublicLobby(template, game, lobbyBoardSources)]),
  ) as Record<(typeof gameIds)[number], string>;
  expectPublicPageStructuredData(
    "https://tetraboard.net",
    renderGeneralLobby(template, lobbyBoardSources),
    lobbies,
    renderFourShogiRules(template, lobbyBoardSources, resolveRulesDiagramAsset),
  );
});

test.each([...gameIds])("公開後のHTML検証は%sの生成済みナビゲーションを受け付ける", (game) => {
  const html = renderPublicLobby(template, game, lobbyBoardSources);
  expect(() =>
    validateDeploymentLobbyHtml(html, game, {
      publicOrigin: "https://tetraboard.net",
      searchIndexable: true,
    }),
  ).not.toThrow();
  expectPublicPageSocialTags(
    html,
    lobbyMetadata[game],
    `https://tetraboard.net${gameCatalog[game].lobbyPath}`,
    game,
  );
});

test.each(["/", "/how-to-play", "/games/gomoku"])(
  "公開後のHTML検証はナビ内の%sリンク欠落を本文のリンクで代用しない",
  (path) => {
    const html = renderPublicLobby(template, "gomoku", lobbyBoardSources);
    const navigation = html.match(
      /<nav\b[^>]*aria-label="メインナビゲーション"[^>]*>[\s\S]*?<\/nav>/,
    )![0];
    const incomplete = html.replace(navigation, navigation.replace(`href="${path}"`, ""));
    expect(incomplete).toContain("data-startup-reload");
    expect(incomplete).toContain('href="/games/gomoku"');
    expect(() =>
      validateDeploymentLobbyHtml(incomplete, "gomoku", {
        publicOrigin: "https://tetraboard.net",
        searchIndexable: true,
      }),
    ).toThrow(`Missing lobby navigation: href="${path}"`);
  },
);

test("公開後のHTML検証はメインナビ全体の欠落を拒否する", () => {
  const html = renderPublicLobby(template, "gomoku", lobbyBoardSources).replace(
    /<nav\b[^>]*aria-label="メインナビゲーション"[^>]*>[\s\S]*?<\/nav>/,
    "",
  );
  expect(() =>
    validateDeploymentLobbyHtml(html, "gomoku", {
      publicOrigin: "https://tetraboard.net",
      searchIndexable: true,
    }),
  ).toThrow("Missing lobby navigation");
});

test.each([
  `<title>${lobbyMetadata.gomoku.title}</title>`,
  'href="https://tetraboard.net/games/gomoku"',
  'content="index,follow"',
  'name="description"',
  'data-public-lobby="gomoku"',
  lobbyMetadata.gomoku.overview,
])("公開後のHTML検証は既存のメタ情報・本文の欠落を拒否する: %s", (expected) => {
  const html = renderPublicLobby(template, "gomoku", lobbyBoardSources).replace(expected, "");
  expect(() =>
    validateDeploymentLobbyHtml(html, "gomoku", {
      publicOrigin: "https://tetraboard.net",
      searchIndexable: true,
    }),
  ).toThrow(`Missing lobby content: ${expected}`);
});

test("初期HTMLはViteの盤画像URLをタイトルとナビで共用し、五目盤を共有する", () => {
  const manifest = Object.fromEntries(
    gameIds.map((game) => [
      `src/assets/lobby/${game === "four-gomoku" ? "gomoku" : game}.webp`,
      { file: lobbyBoardSources[game].slice(1) },
    ]),
  );
  const sources = lobbyBoardSourcesFromManifest(manifest);
  expect(sources["four-gomoku"]).toBe(sources.gomoku);
  for (const game of gameIds) {
    const html = renderPublicLobby(template, game, sources);
    const boards = [...html.matchAll(/<img\b[^>]*data-testid="lobby-board-preview"[^>]*>/g)];
    expect(boards).toHaveLength(2);
    for (const [board] of boards) expect(board).toContain(`src="${sources[game]}"`);
    expect(html).not.toContain("/src/assets/");
  }
  expect(renderGeneralLobby(template, sources)).toContain(`src="${sources["four-reversi"]}"`);
  expect(() => lobbyBoardSourcesFromManifest({})).toThrow("Missing built lobby board asset");
});

test("既定HTMLと全公開ロビーはブランド表記をそろえ、四人リバーシ・四人五目並べはtitleの語順をそろえる", async () => {
  const source = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(source).toContain("<title>TetraBoard</title>");
  for (const html of [
    source,
    renderGeneralLobby(source, lobbyBoardSources),
    ...gameIds.map((game) => renderPublicLobby(source, game, lobbyBoardSources)),
  ]) {
    expect(html).not.toContain("Tetra Board");
    expect(html.match(/property="og:site_name" content="TetraBoard"/g)).toHaveLength(1);
  }
  for (const game of gameIds) {
    const html = renderPublicLobby(template, game, lobbyBoardSources);
    const { title, description } = lobbyMetadata[game];
    expect(title).toStartWith(gameCatalog[game].name);
    if (game === "four-reversi" || game === "four-gomoku") {
      expect(title).toEndWith("をブラウザで無料対戦 | TetraBoard");
      expect(
        [...title].reduce((width, char) => width + (char.charCodeAt(0) < 128 ? 0.5 : 1), 0),
      ).toBeLessThanOrEqual(33);
    }
    expect(description.length).toBeLessThanOrEqual(120);
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(`name="description" content="${description}"`);
  }
});

test.each([
  {
    path: "/",
    html: renderGeneralLobby(template, lobbyBoardSources),
    title: "TetraBoard | 四人将棋・四人リバーシをブラウザで無料対戦",
    description:
      "四人将棋・四人リバーシ・四人五目並べなど6つのボードゲームをブラウザで無料対戦。登録不要でCPUや友達とすぐ遊べます。公開ルームの観戦や毎週の大会も楽しめます。",
  },
  {
    path: "/games/four-shogi",
    html: renderPublicLobby(template, "four-shogi", lobbyBoardSources),
    game: "four-shogi",
    title: "四人将棋（4人将棋）を無料でオンライン対戦｜登録不要・毎週大会 | TetraBoard",
    description:
      "四人将棋（4人将棋）をブラウザで無料対戦。登録・インストール不要で、CPU戦も友達との対局もすぐ遊べます。シングルス・ダブルスに対応。毎週土曜の夜に大会を開いていて、対局の棋譜も見られます。",
  },
  {
    path: "/games/gomoku",
    html: renderPublicLobby(template, "gomoku", lobbyBoardSources),
    game: "gomoku",
    title: "五目並べを無料でオンライン対戦｜友達と2人・CPU戦・登録不要 | TetraBoard",
    description:
      "五目並べ（五目ならべ）をブラウザで無料オンライン対戦。登録・インストール不要で、招待URLを送るだけで友達と2人で遊べます。CPU戦でひとりでも練習でき、禁手ありとなしを選べます。スマホでもPCでも遊べ、対局の棋譜も見られます。",
  },
  {
    path: "/games/reversi",
    html: renderPublicLobby(template, "reversi", lobbyBoardSources),
    game: "reversi",
    title: "リバーシを無料でオンライン対戦｜友達と2人・CPU戦・登録不要 | TetraBoard",
    description:
      "リバーシ（オセロと同じ遊び方）をブラウザで無料オンライン対戦。登録不要で、招待URLを送るだけで友達と2人で遊べます。CPU戦でひとりでも練習でき、登録するとレート戦にも参加できます。スマホでもPCでも遊べ、棋譜も見られます。",
  },
  {
    path: "/games/shogi",
    html: renderPublicLobby(template, "shogi", lobbyBoardSources),
    game: "shogi",
    title: "将棋を無料でオンライン対戦｜友達と2人・CPU戦・登録不要 | TetraBoard",
    description:
      "将棋をブラウザで無料オンライン対戦。ダウンロード・登録不要で、招待URLを送るだけで友達と2人で対局できます。CPU戦でひとりでも練習でき、登録するとレート戦にも参加できます。スマホでもPCでも遊べ、対局の棋譜も見られます。",
  },
] as const)("$path の検索・OGP・Xのメタ情報は承認済みの文面と一致する", (page) => {
  const canonical = `https://tetraboard.net${page.path}`;
  expect(page.html).toContain(`<title>${page.title}</title>`);
  expect(page.html).toContain(`<meta name="description" content="${page.description}"`);
  expect(page.html).toContain(`<link rel="canonical" href="${canonical}" />`);
  expectPublicPageSocialTags(page.html, page, canonical, "game" in page ? page.game : undefined);
});

test("四人ゲームの初期HTMLは固有本文・正規URL・描画資産と通常リンクを持つ", () => {
  for (const [game, keyword, detail] of [
    ["four-reversi", "4人オセロ", "全滅手は禁止"],
    ["four-shogi", "4人将棋", "三人攻撃禁止は初期値ON"],
    ["four-gomoku", "四人五目並べ", "味方2色が混ざった五連"],
  ] as const) {
    const html = renderPublicLobby(template, game, lobbyBoardSources);
    expect(html.match(/<title>(.*?)<\/title>/)?.[1]).toContain(keyword);
    expect(lobbyMetadata[game].description).toContain(keyword);
    expect(lobbyMetadata[game].overview.split(keyword)).toHaveLength(2);
    expect(html).toContain(`href="https://tetraboard.net/games/${game}"`);
    expect(html).toContain('name="description"');
    expect(html).toContain('content="index,follow"');
    expect(html).toContain(detail);
    expect(html).toContain("CPU3人との待機室");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(`href="${gameCatalog[game].lobbyPath}"`);
    expect(html).toContain('href="/how-to-play"');
    expect(html).toContain('aria-label="メインナビゲーション"');
    expect(html).not.toContain('aria-label="ゲームを選択"');
    expect(html).toContain('src="/assets/app-123.js"');
    expect(html).toContain('href="/assets/app-123.css"');
    expect(html).not.toContain("noindex");
  }
});

test("四人将棋のロビーの初期HTMLは大会一覧へリンクする", () => {
  const html = renderPublicLobby(template, "four-shogi", lobbyBoardSources);
  expect(html).toMatch(/<a\b[^>]*href="\/tournaments"[^>]*>大会の日程と結果<\/a>/);
});

test("四人将棋のルールは初期HTMLに図・コツ・FAQ・メタ情報とロビー・大会へのリンクを持つ", () => {
  const html = renderFourShogiRules(template, lobbyBoardSources, resolveRulesDiagramAsset);
  expect(html).toMatch(/<h1\b[^>]*>四人将棋のルール<\/h1>/);
  expect(html).toContain(
    "<title>四人将棋のルール｜駒の動き・成り・禁じ手を図で解説｜TetraBoard</title>",
  );
  const description = html.match(/name="description" content="([^"]*)"/)![1]!;
  expect(description).toBe(
    "四人将棋（4人将棋）のルールを図で解説します。初期配置、駒の動きと成り、王手を受けた人の手番、持ち駒、禁じ手、シングルスとダブルスの違いに加え、勝ち方のコツとよくある質問も紹介します。ブラウザで無料で遊べます。",
  );
  expect([...description].length).toBeLessThanOrEqual(120);
  expect(html).toContain('name="robots" content="index,follow"');
  expect(html).toContain('rel="canonical" href="https://tetraboard.net/games/four-shogi/rules"');
  expectPublicPageSocialTags(
    html,
    fourShogiRulesMetadata,
    "https://tetraboard.net/games/four-shogi/rules",
    "four-shogi",
  );
  expect(html).toContain('data-public-lobby="four-shogi-rules"');
  expect(html).toContain("王手を受けた人の手番を優先");
  expect(html).toContain("成った銀と歩は金と同じ動きです。");
  expect(
    Array.from(html.matchAll(/<h2\b[^>]*>([^<]+)<\/h2>/g), ([, name]) => name).slice(-2),
  ).toEqual(["勝ち方のコツ", "よくある質問"]);
  expect(Array.from(html.matchAll(/<h3\b[^>]*>([^<]+)<\/h3>/g), ([, name]) => name)).toEqual([
    "王手で手番の順番が変わる",
    "3人の相手を同時に見る",
    "駒が少ないので1枚が重い",
    "脱落した人の駒を取る",
    "三人攻撃禁止を意識する",
    "通常の将棋との違いは？",
    "4人そろわなくても遊べる？",
    "大会はある？",
  ]);
  expect(html.match(/<div role="img" aria-label="[^"]+"/g)).toHaveLength(8);
  expect(html.match(/<img[^>]+src="\/assets\/board-wood-fixture1\.webp"/g)).toHaveLength(8);
  for (const kind of ["king2", "rook", "prom_rook", "gold", "silver", "pawn"])
    expect(html).toContain(`src="/assets/up_${kind}-fixture1.png"`);
  expect(html).toMatch(/<a\b[^>]*href="\/games\/four-shogi"[^>]*>四人将棋で遊ぶ<\/a>/);
  expect(html).toMatch(/<a\b[^>]*href="\/tournaments"[^>]*>大会の日程と結果<\/a>/);
  expect(html).toContain('src="/assets/app-123.js"');
  expect(html).toContain(`src="${lobbyBoardSources["four-shogi"]}"`);
});

test("サイトマップは総合と6ゲームのロビー、四人将棋のルールを掲載する", () => {
  const xml = renderSitemap();
  expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  expect(xml.match(/<loc>/g)).toHaveLength(8);
  expect(xml.match(/<lastmod>/g)).toHaveLength(8);
  for (const [url, lastModified] of [
    ["https://tetraboard.net/", generalLobbyMetadata.lastModified],
    [`https://tetraboard.net${fourShogiRulesPath}`, "2026-11-24"],
    ...gameIds.map((game) => [
      `https://tetraboard.net${gameCatalog[game].lobbyPath}`,
      game === "four-shogi" ? "2026-11-24" : lobbyMetadata[game].lastModified,
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
  expect(() => renderPublicLobby("<html></html>", "four-shogi", lobbyBoardSources)).toThrow(
    "template markers",
  );
});

test("総合ロビーの初期HTMLは全ゲームへの入口と正規URLを持つ", () => {
  const html = renderGeneralLobby(template, lobbyBoardSources);
  expect(html).toContain('data-public-lobby="all"');
  expect(html).toContain('href="https://tetraboard.net/"');
  expect(html).toContain("<h1>総合ロビー</h1>");
  expect(html).not.toContain("chat-1");
});
