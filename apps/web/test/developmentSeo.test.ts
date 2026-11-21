import { expect, test } from "bun:test";

test("開発ビルドのHTML・サイトマップ・画面内遷移は開発URLと検索除外を維持する", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { createMemoryRouter } from "react-router";
    import { Window } from "happy-dom";
    import { renderFourShogiRules, renderPublicLobby, renderSitemap, robotsText } from "./build/renderPublicLobby";
    import { lobbyBoardSources, resolveRulesDiagramAsset } from "./test/fixtures/lobbyBoardSources";
    import { startPageMetadata, updatePageMetadata } from "./src/seo/pageMetadata";
    import { validateDeploymentLobbyHtml } from "../../scripts/deploymentLobbyHtml";
    const window = new Window();
    globalThis.document = window.document;
    const template = '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>';
    const html = renderPublicLobby(template, "four-reversi", lobbyBoardSources);
    validateDeploymentLobbyHtml(html, "four-reversi", {
      publicOrigin: "https://tetraboard-dev.chaossi-lab.workers.dev",
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
    console.log(JSON.stringify({ html, rulesHtml, sitemap: renderSitemap(), robotsText, pages }));
  `,
    ],
    {
      cwd: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
      env: {
        ...process.env,
        VITE_PUBLIC_ORIGIN: "https://tetraboard-dev.chaossi-lab.workers.dev",
        VITE_SEARCH_INDEXABLE: "false",
      },
    },
  );
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  expect(output.html).toContain('content="noindex,follow"');
  expect(output.html).toContain(
    'href="https://tetraboard-dev.chaossi-lab.workers.dev/games/four-reversi"',
  );
  expect(output.rulesHtml).toContain('content="noindex,follow"');
  expect(output.rulesHtml).toContain(
    'href="https://tetraboard-dev.chaossi-lab.workers.dev/games/four-shogi/rules"',
  );
  expect(output.pages[5]).toContain(
    'href="https://tetraboard-dev.chaossi-lab.workers.dev/games/four-shogi/rules"',
  );
  expect(output.sitemap).not.toContain("<loc>");
  expect(output.sitemap).not.toContain("<lastmod>");
  expect(output.robotsText).toContain("Allow: /");
  expect(output.robotsText).not.toContain("Sitemap:");
  for (const page of output.pages) {
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
});
