import { expect, test } from "bun:test";
import { fourShogiRulesPath, gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { fourShogiRulesMetadata } from "../src/seo/fourShogiRulesMetadata";
import { howToPlayMetadata } from "../src/seo/howToPlayMetadata";
import { generalLobbyMetadata, lobbyMetadata } from "../src/seo/lobbyMetadata";
import { expectPublicPageSocialTags } from "./fixtures/publicPageSocialTags";
import { expectPublicPageStructuredData } from "./fixtures/publicPageStructuredData";

const developmentOrigin = "https://tetraboard-dev.chaossi-lab.workers.dev";

test("開発ビルドのHTML・サイトマップ・画面内遷移は開発URLと検索除外を維持する", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { createMemoryRouter } from "react-router";
    import { Window } from "happy-dom";
    import { gameIds } from "@tetraboard/protocol/games";
    import { renderFourShogiRules, renderGeneralLobby, renderHowToPlay, renderPublicLobby, renderSitemap, robotsText } from "./build/renderPublicLobby";
    import { boardPageMetadata } from "./src/features/board/boardPageMetadata";
    import { helpScreenshots } from "./src/features/help/helpScreenshots";
    import { lobbyBoardSources, resolveRulesDiagramAsset } from "./test/fixtures/lobbyBoardSources";
    import { startPageMetadata, updatePageMetadata } from "./src/seo/pageMetadata";
    import { validateDeploymentLobbyHtml } from "../../scripts/deploymentLobbyHtml";
    const window = new Window();
    globalThis.document = window.document;
    const template = await Bun.file("index.html").text();
    const lobbies = Object.fromEntries(gameIds.map((game) => [
      game,
      renderPublicLobby(template, game, lobbyBoardSources),
    ]));
    const home = renderGeneralLobby(template, lobbyBoardSources);
    validateDeploymentLobbyHtml(lobbies["four-reversi"], "four-reversi", {
      publicOrigin: "${developmentOrigin}",
      searchIndexable: false,
    });
    const pages = [];
    for (const path of ["/games/four-reversi", "/matches/example", "/games/shogi", "/tournaments/"]) {
      updatePageMetadata(path);
      pages.push(document.head.innerHTML);
    }
    updatePageMetadata("/tournaments/1", undefined, undefined, {
      id: 1,
      name: "開発の大会",
      game: "four-reversi",
      startsAtMs: Date.UTC(2026, 10, 20, 16),
      status: "upcoming",
      entryCount: 0,
      finalizedAtMs: null,
    });
    pages.push(document.head.innerHTML);
    const rulesHtml = renderFourShogiRules(template, lobbyBoardSources, resolveRulesDiagramAsset);
    const router = createMemoryRouter([
      { path: "/" },
      { path: "/games/four-shogi/rules", lazy: () => import("./src/features/lobby/fourShogiRulesRoute") },
    ]);
    const stop = startPageMetadata(router);
    await router.navigate("/games/four-shogi/rules");
    pages.push(document.head.innerHTML);
    stop();
    router.dispose();
    updatePageMetadata("/posts/example", undefined, undefined, undefined, undefined, boardPageMetadata({
      post: { id: "example", status: "published", gameId: "shogi", text: "開発の投稿" },
      replies: [],
      indexable: true,
    }));
    const boardHead = document.head.innerHTML;
    const helpHtml = renderHowToPlay(template, lobbyBoardSources, helpScreenshots);
    updatePageMetadata("/how-to-play");
    const helpHead = document.head.innerHTML;
    console.log(JSON.stringify({ home, lobbies, rulesHtml, helpHtml, helpHead, boardHead, sitemap: renderSitemap(), robotsText, pages }));
  `,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
      env: {
        ...process.env,
        VITE_PUBLIC_ORIGIN: developmentOrigin,
        VITE_SEARCH_INDEXABLE: "false",
      },
    },
  );
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  expectPublicPageStructuredData(developmentOrigin, output.home, output.lobbies, output.rulesHtml);
  expectPublicPageSocialTags(output.home, generalLobbyMetadata, `${developmentOrigin}/`);
  for (const game of gameIds) {
    expectPublicPageSocialTags(
      output.lobbies[game],
      lobbyMetadata[game],
      `${developmentOrigin}${gameCatalog[game].lobbyPath}`,
      game,
    );
  }
  expectPublicPageSocialTags(
    output.rulesHtml,
    fourShogiRulesMetadata,
    `${developmentOrigin}${fourShogiRulesPath}`,
    "four-shogi",
  );
  expectPublicPageSocialTags(
    output.pages[5],
    fourShogiRulesMetadata,
    `${developmentOrigin}${fourShogiRulesPath}`,
    "four-shogi",
  );
  expect(output.pages[5]).toContain(
    'href="https://tetraboard-dev.chaossi-lab.workers.dev/games/four-shogi/rules"',
  );
  for (const page of [output.helpHtml, output.helpHead]) {
    expect(page).toContain(`href="${developmentOrigin}/how-to-play"`);
    expectPublicPageSocialTags(page, howToPlayMetadata, `${developmentOrigin}/how-to-play`);
  }
  expect(output.sitemap).not.toContain("<loc>");
  expect(output.sitemap).not.toContain("<lastmod>");
  expect(output.robotsText).toBe("User-agent: *\nAllow: /\n");
  expect(output.boardHead).toContain(`href="${developmentOrigin}/posts/example"`);
  expect(output.boardHead).toContain(`content="${developmentOrigin}/assets/ogp/shogi.png"`);
  for (const page of [
    output.home,
    ...Object.values(output.lobbies),
    output.rulesHtml,
    output.helpHtml,
    output.helpHead,
    output.boardHead,
    ...output.pages,
  ]) {
    expect(page).toContain('content="noindex,follow"');
    expect(page).not.toContain("https://tetraboard.net");
  }
  expect(output.pages[2]).toContain("https://tetraboard-dev.chaossi-lab.workers.dev/games/shogi");
  expect(output.pages[3]).toContain("https://tetraboard-dev.chaossi-lab.workers.dev/tournaments");
  expect(output.pages[3]).toContain("大会一覧｜TetraBoard");
  expect(output.pages[4]).toContain(
    'href="https://tetraboard-dev.chaossi-lab.workers.dev/tournaments/1"',
  );
  expect(output.pages[4]).toContain("四人リバーシの大会です。2026年11月21日に開催します。");
  for (const page of output.pages) expect(page).not.toContain("application/ld+json");
});
