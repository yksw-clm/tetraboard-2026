import { expect, test } from "bun:test";
import { createMemoryRouter } from "react-router";
import { GameIntroduction } from "../src/seo/GameIntroduction";
import { updatePageMetadata } from "../src/seo/pageMetadata";
import { startPublicLobby } from "../src/seo/startPublicLobby";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { renderGeneralLobby, renderPublicLobby } from "../build/renderPublicLobby";
import { lobbyBoardSources } from "../test/fixtures/lobbyBoardSources";
import { render, flush } from "./support";

test("大会の実URLはnoindexと自身のcanonicalを持ち、ロビー移動で取り替える", () => {
  const previousHead = document.head.innerHTML;
  try {
    updatePageMetadata("/tournaments/12");
    expect(document.title).toBe("四人将棋大会 | TetraBoard");
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex,follow",
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://tetraboard.net/tournaments/12",
    );
    updatePageMetadata("/games/four-shogi");
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://tetraboard.net/games/four-shogi",
    );
  } finally {
    document.head.innerHTML = previousHead;
  }
});

test("四人将棋・四人リバーシの開始手順とFAQは初期HTMLと通常画面で同じ内容を読める", () => {
  const template =
    '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>';
  for (const game of ["four-shogi", "four-reversi"] as const) {
    const view = render(<GameIntroduction game={game} />);
    expect([...view.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "ゲーム概要",
      "ひとりでCPUと遊ぶ",
      "友人とオンラインで遊ぶ",
      "TetraBoardの主要ルール",
      "よくある質問",
    ]);
    const steps = view.querySelectorAll("ol");
    expect(steps).toHaveLength(2);
    expect(steps[0]!.children).toHaveLength(3);
    expect(steps[1]!.children).toHaveLength(4);
    expect(steps[0]!.textContent).toContain("CPU3人との待機室");
    expect(steps[1]!.textContent).toContain("準備完了");
    expect(steps[1]!.textContent).toContain("対局開始");
    expect(view.textContent).toContain("招待URLを共有した部屋も公開ルーム一覧に掲載");
    expect(view.textContent).toContain("自動では始まりません");
    expect(view.textContent).toContain("シングルス");
    expect(view.textContent).toContain("ダブルス");
    expect(view.textContent).toContain("ユーザー登録は不要");
    expect(view.querySelectorAll("h3")).toHaveLength(3);
    expect(view.querySelector('[role="dialog"]')).toBeNull();
    expect(view.querySelector("details")).toBeNull();
    expect(view.querySelector("a")?.textContent).toBe("詳しい遊び方を見る");
    expect(view.querySelector("a")?.getAttribute("href")).toBe("/how-to-play");
    const initial = document.implementation.createHTMLDocument();
    initial.documentElement.innerHTML = renderPublicLobby(template, game, lobbyBoardSources);
    expect(
      initial.querySelector(`section[aria-label="${gameCatalog[game].name}の紹介"]`)!.textContent,
    ).toBe(view.textContent);
  }
});

test("他4ゲームの紹介は従来の構成を維持する", () => {
  for (const game of ["four-gomoku", "gomoku", "shogi", "reversi"] as const) {
    const view = render(<GameIntroduction game={game} />);
    expect([...view.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "ゲーム概要",
      "遊び始め方",
      "主要ルール",
    ]);
    expect(view.querySelector("h3")).toBeNull();
  }
});

test("全公開ロビーの初期HTMLと画面内遷移は同じtitle・description・ブランド表記を持つ", async () => {
  const previousHead = document.head.innerHTML;
  const template = await Bun.file(new URL("../index.html", import.meta.url)).text();
  try {
    const pages = [
      { path: "/", html: renderGeneralLobby(template, lobbyBoardSources) },
      ...gameIds.map((game) => ({
        path: gameCatalog[game].lobbyPath,
        html: renderPublicLobby(template, game, lobbyBoardSources),
      })),
    ];
    for (const { path, html } of pages) {
      const initial = document.implementation.createHTMLDocument();
      initial.documentElement.innerHTML = html;
      updatePageMetadata(path);
      expect(document.title).toBe(initial.title);
      expect(document.head.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
        initial.querySelector('meta[name="description"]')?.getAttribute("content"),
      );
      expect(document.head.querySelectorAll('meta[property="og:site_name"]')).toHaveLength(1);
      expect(
        document.head.querySelector('meta[property="og:site_name"]')?.getAttribute("content"),
      ).toBe("TetraBoard");
    }
  } finally {
    document.head.innerHTML = previousHead;
  }
});

test.each([
  ["/terms", "利用規約 | TetraBoard"],
  ["/privacy", "プライバシーポリシー | TetraBoard"],
])("%sの初期表示と再読み込みで文書名を含むタイトルを維持する", (path, title) => {
  const previousHead = document.head.innerHTML;
  try {
    for (const initialTitle of ["TetraBoard", title]) {
      document.title = initialTitle;
      updatePageMetadata(path);
      expect(document.title).toBe(title);
      expect(document.head.querySelector('meta[name="robots"]')!.getAttribute("content")).toBe(
        "noindex,follow",
      );
    }
  } finally {
    document.head.innerHTML = previousHead;
  }
});

test("ロビー往復・棋譜・履歴移動でメタ情報を同期し古いcanonicalとnoindexを残さない", async () => {
  const router = createMemoryRouter([{ path: "*", element: <div /> }], {
    initialEntries: ["/games/four-shogi"],
  });
  const previousTitle = document.title;
  updatePageMetadata(router.state.location.pathname);
  const unsubscribe = router.subscribe((state) => updatePageMetadata(state.location.pathname));
  try {
    expect(document.title).toContain("四人将棋（4人将棋）を");
    expect(document.head.querySelector('link[rel="canonical"]')!.getAttribute("href")).toBe(
      "https://tetraboard.net/games/four-shogi",
    );
    await router.navigate("/terms?from=lobby");
    expect(document.title).toBe("利用規約 | TetraBoard");
    await router.navigate("/privacy#contact");
    expect(document.title).toBe("プライバシーポリシー | TetraBoard");
    expect(document.head.querySelector('meta[name="robots"]')!.getAttribute("content")).toBe(
      "noindex,follow",
    );
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.head.querySelector('meta[name="description"]')).toBeNull();
    await router.navigate(-1);
    expect(document.title).toBe("利用規約 | TetraBoard");
    await router.navigate(-1);
    expect(document.title).toContain("四人将棋（4人将棋）を");
    await router.navigate("/matches/example");
    expect(document.head.querySelector('meta[name="robots"]')!.getAttribute("content")).toBe(
      "noindex,follow",
    );
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.head.querySelector('meta[name="description"]')).toBeNull();
    await router.navigate("/games/four-reversi?test=1");
    expect(document.title).toContain("四人リバーシ（4人オセロ）を");
    expect(document.head.querySelector('meta[name="robots"]')!.getAttribute("content")).toBe(
      "index,follow",
    );
    await router.navigate(-1);
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    await router.navigate(-1);
    expect(document.title).toContain("四人将棋（4人将棋）を");
    expect(document.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
    for (const path of [
      "/login",
      "/account",
      "/feedback",
      "/updates",
      "/updates/feedback",
      "/rooms/12345",
      "/unknown",
    ]) {
      await router.navigate(path);
      if (!path.startsWith("/rooms/")) expect(document.title).toBe("TetraBoard");
      expect(document.head.querySelector('meta[name="robots"]')!.getAttribute("content")).toBe(
        "noindex,follow",
      );
    }
  } finally {
    unsubscribe();
    router.dispose();
    document.head
      .querySelectorAll('meta[name="robots"],meta[name="description"],link[rel="canonical"]')
      .forEach((node) => node.remove());
    document.title = previousTitle;
  }
});

test("初期紹介を遅延読み込み中に保ち、成功時だけ一度置き換える", async () => {
  let resolve!: (value: { Component: () => null }) => void;
  const router = createMemoryRouter(
    [
      {
        path: "/games/four-shogi",
        lazy: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    ],
    { initialEntries: ["/games/four-shogi"] },
  );
  const root = document.createElement("div");
  root.dataset.publicLobby = "four-shogi";
  root.innerHTML = '<h1>四人将棋</h1><p data-startup-status role="status">読み込み中</p>';
  let mounts = 0;
  startPublicLobby(root, router, () => {
    mounts++;
    root.replaceChildren(document.createTextNode("対局画面"));
  });
  expect(mounts).toBe(0);
  expect(root.textContent).toContain("四人将棋");
  resolve({ Component: () => null });
  await flush();
  expect(mounts).toBe(1);
  expect(root.textContent).toBe("対局画面");
  await router.revalidate();
  expect(mounts).toBe(1);
  router.dispose();
});

test("遅延読み込み失敗は紹介とリンクを保持して再読み込みを案内する", async () => {
  let reject!: (reason: Error) => void;
  const router = createMemoryRouter(
    [
      {
        path: "/games/four-reversi",
        lazy: () =>
          new Promise((_, r) => {
            reject = r;
          }),
      },
    ],
    { initialEntries: ["/games/four-reversi"] },
  );
  const root = document.createElement("div");
  root.dataset.publicLobby = "four-reversi";
  root.innerHTML =
    '<h1>四人リバーシ</h1><p data-startup-status></p><a href="/games/four-reversi">再読み込み</a>';
  let mounted = false;
  startPublicLobby(root, router, () => {
    mounted = true;
  });
  reject(new Error("chunk unavailable"));
  await flush();
  expect(mounted).toBe(false);
  expect(root.querySelector("h1")!.textContent).toBe("四人リバーシ");
  expect(root.querySelector('[role="alert"]')!.textContent).toContain("再読み込み");
  expect(root.querySelector("a")!.getAttribute("href")).toBe("/games/four-reversi");
  router.dispose();
});
