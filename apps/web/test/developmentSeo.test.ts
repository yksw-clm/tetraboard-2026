import { expect, test } from "bun:test";

test("開発ビルドのHTML・サイトマップ・画面内遷移は開発URLと検索除外を維持する", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { Window } from "happy-dom";
    import { renderPublicLobby, renderSitemap, robotsText } from "./build/renderPublicLobby";
    import { lobbyBoardSources } from "./test/fixtures/lobbyBoardSources";
    import { updatePageMetadata } from "./src/seo/pageMetadata";
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
    for (const path of ["/games/four-reversi", "/matches/example", "/games/shogi"]) {
      updatePageMetadata(path);
      pages.push(document.head.innerHTML);
    }
    console.log(JSON.stringify({ html, sitemap: renderSitemap(), robotsText, pages }));
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
  expect(output.sitemap).not.toContain("<loc>");
  expect(output.sitemap).not.toContain("<lastmod>");
  expect(output.robotsText).toContain("Allow: /");
  expect(output.robotsText).not.toContain("Sitemap:");
  for (const page of output.pages) {
    expect(page).toContain('content="noindex,follow"');
    expect(page).not.toContain("https://tetraboard.net");
  }
  expect(output.pages[2]).toContain("https://tetraboard-dev.chaossi-lab.workers.dev/games/shogi");
});
