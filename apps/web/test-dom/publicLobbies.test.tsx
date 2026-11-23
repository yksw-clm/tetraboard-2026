import { shogiPieceImage } from "@tetraboard/shogi-ui/images";
import { expect, spyOn, test } from "bun:test";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { GameIntroduction } from "../src/seo/GameIntroduction";
import { startPageMetadata, updatePageMetadata } from "../src/seo/pageMetadata";
import { startPublicLobby } from "../src/seo/startPublicLobby";
import { fourShogiRulesPath, gameCatalog, gameIds } from "@tetraboard/protocol/games";
import {
  renderFourShogiRules,
  renderGeneralLobby,
  renderPublicLobby,
} from "../build/renderPublicLobby";
import { lobbyBoardSources, resolveRulesDiagramAsset } from "../test/fixtures/lobbyBoardSources";
import { readSocialTags } from "../test/fixtures/publicPageSocialTags";
import { act, render, flush, requests } from "./support";
import { profile } from "../test/fixtures/account";
import { AccountLayout } from "../src/features/account/AccountSession";
import { createInitialState } from "@tetraboard/four-shogi";
import { HowToPlayDialog } from "../src/features/lobby/HowToPlayDialog";

const jsonLdSelector = 'script[type="application/ld+json"]';

test.each([
  ["/tournaments/", true, "大会一覧｜TetraBoard"],
  ["/tournaments/", false, "大会一覧｜TetraBoard"],
  ["/tournaments/12/", true, "大会｜TetraBoard"],
  ["/tournaments/12/", false, "大会｜TetraBoard"],
] as const)(
  "%s の初期HTMLのメタ情報を保持する（公開HTML: %s）",
  async (path, published, spaTitle) => {
    const router = createMemoryRouter([{ path: "*", element: <div /> }], {
      initialEntries: [path],
    });
    const previousHead = document.head.innerHTML;
    document.head.innerHTML = published
      ? `<title>Workerの大会ページ</title>
       <meta name="description" content="Workerの説明">
       <meta name="robots" content="index,follow">
       <link rel="canonical" href="https://tetraboard.net${path.slice(0, -1)}">
       <meta property="og:site_name" content="TetraBoard">
       <meta property="og:title" content="Workerの大会ページ">
       <meta name="twitter:card" content="summary_large_image">
       <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>`
      : '<title>TetraBoard</title><meta name="robots" content="noindex,follow">';
    const initialHead = document.head.innerHTML;
    const stop = startPageMetadata(router);
    try {
      expect(document.head.innerHTML).toBe(initialHead);
      await router.revalidate();
      expect(document.head.innerHTML).toBe(initialHead);

      await router.navigate("/terms");
      expect(document.head.querySelector(jsonLdSelector)).toBeNull();
      await router.navigate(-1);
      expect(document.title).toBe(spaTitle);
      expect(document.head.querySelector(jsonLdSelector)).toBeNull();
    } finally {
      stop();
      router.dispose();
      document.head.innerHTML = previousHead;
    }
  },
);

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

test.each([
  ["gomoku", "禁手（三三・四四・長連）とは？", "スマホでも遊べる？"],
  ["reversi", "置ける場所がないときは？", "レート戦とは？"],
  ["shogi", "CPUの強さは選べる？", "引き分けになるのはどんなとき？"],
] as const)("%s の紹介は2人用の開始手順とFAQを表示する", (game, secondQuestion, thirdQuestion) => {
  const template =
    '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>';
  const view = render(<GameIntroduction game={game} />);
  expect([...view.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
    "ゲーム概要",
    "ひとりでCPUと遊ぶ",
    "友達とオンラインで遊ぶ",
    "TetraBoardの主要ルール",
    "よくある質問",
  ]);
  const steps = view.querySelectorAll("ol");
  expect(steps).toHaveLength(2);
  expect(steps[0]!.children).toHaveLength(3);
  expect(steps[1]!.children).toHaveLength(4);
  expect(steps[0]!.textContent).toContain(
    "名前・時間設定などを選ぶと、CPU1人との待機室へ進みます。",
  );
  expect(steps[1]!.textContent).toContain("人間とCPUで2席を埋めます。");
  expect(view.textContent).toContain("人間が2人集まらなくても");
  expect(view.textContent).not.toContain("人間が4人集まらなくても");
  expect(view.textContent).not.toContain("CPU3人");
  expect(view.textContent).not.toContain("4席");
  expect([...view.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
    "友達と2人で遊ぶには？",
    secondQuestion,
    thirdQuestion,
  ]);

  const initial = document.implementation.createHTMLDocument();
  initial.documentElement.innerHTML = renderPublicLobby(template, game, lobbyBoardSources);
  expect(
    initial.querySelector(`section[aria-label="${gameCatalog[game].name}の紹介"]`)!.textContent,
  ).toBe(view.textContent);
});

test("四人五目並べの紹介は3項目を表示する", () => {
  const view = render(<GameIntroduction game="four-gomoku" />);
  expect([...view.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
    "ゲーム概要",
    "遊び始め方",
    "主要ルール",
  ]);
  expect(view.querySelector("h3")).toBeNull();
});

test("四人将棋のロビーだけが紹介にルールと大会一覧へのリンクを持つ", () => {
  const template =
    '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>';
  for (const game of gameIds) {
    const view = render(
      <MemoryRouter>
        <GameIntroduction game={game} />
      </MemoryRouter>,
    );
    const initial = document.implementation.createHTMLDocument();
    initial.documentElement.innerHTML = renderPublicLobby(template, game, lobbyBoardSources);
    for (const content of [
      view,
      initial.querySelector(`section[aria-label="${gameCatalog[game].name}の紹介"]`)!,
    ]) {
      const link = content.querySelector(`a[href="${fourShogiRulesPath}"]`);
      const tournamentLink = content.querySelector('a[href="/tournaments"]');
      if (game === "four-shogi") {
        expect(link?.textContent).toBe("ルールを詳しく見る");
        expect(tournamentLink?.textContent).toBe("大会の日程と結果");
        expect(content.textContent).not.toContain("詳しいルールはロビー上部");
      } else {
        expect(link).toBeNull();
        expect(tournamentLink).toBeNull();
        expect(content.textContent).toContain(
          "詳しいルールはロビー上部の「遊び方」で確認できます。",
        );
      }
    }
  }
});

test("ルールの初期配置図はエンジンの盤面どおりに駒を配置する", () => {
  const template = '<title>TetraBoard</title><div id="root"></div>';
  const initial = document.implementation.createHTMLDocument();
  initial.body.innerHTML = renderFourShogiRules(
    template,
    lobbyBoardSources,
    resolveRulesDiagramAsset,
  );
  const board = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
  }).board;
  const placement = { south: [], west: [], north: [], east: [] } as Record<
    "south" | "west" | "north" | "east",
    string[]
  >;
  const names = { king: "王", rook: "飛車", gold: "金", silver: "銀", pawn: "歩" };
  const diagram = initial.querySelector('[role="img"][aria-label^="9×9の初期配置"]')!;
  expect(diagram.querySelectorAll("[data-square]")).toHaveLength(36);
  board.forEach((row, y) =>
    row.forEach((piece, x) => {
      const drawn = diagram.querySelector(`[data-square="${x},${y}"]`);
      if (!piece) {
        expect(drawn).toBeNull();
        return;
      }
      expect(drawn?.getAttribute("data-piece")).toBe(piece.kind);
      expect(drawn?.getAttribute("data-side")).toBe(piece.side);
      placement[piece.side].push(`${9 - x}${"一二三四五六七八九"[y]}に${names[piece.kind]}`);
      const direction = { south: "up", west: "right", north: "down", east: "left" } as const;
      const image = drawn?.querySelector("img");
      const expectedDirection = direction[piece.side];
      const { src } = shogiPieceImage(piece.kind, piece.promoted, false, expectedDirection);
      expect(image?.getAttribute("data-piece-direction")).toBe(expectedDirection);
      expect(image?.getAttribute("src")).toBe(resolveRulesDiagramAsset(src));
      expect(image?.classList.contains("invisible")).toBe(false);
      expect(image?.classList.contains("rotate-90")).toBe(piece.side === "west");
      expect(image?.classList.contains("-rotate-90")).toBe(piece.side === "east");
    }),
  );
  expect([...diagram.querySelectorAll(":scope > span")].map((label) => label.textContent)).toEqual([
    "北",
    "西",
    "東",
    "南",
  ]);
  const firstBoard = diagram.querySelector("img")!;
  expect(firstBoard.getAttribute("loading")).not.toBe("lazy");
  expect(firstBoard.getAttribute("fetchpriority")).toBe("high");
  expect(firstBoard.getAttribute("src")).toBe("/assets/board-wood-fixture1.webp");
  const description = initial.querySelector('[aria-label="初期配置の駒と位置"]')!;
  expect(description.classList.contains("sr-only")).toBe(true);
  expect([...description.querySelectorAll("dt")].map((term) => term.textContent)).toEqual([
    "南",
    "西",
    "北",
    "東",
  ]);
  expect(
    [...description.querySelectorAll("dd")].map((definition) => definition.textContent),
  ).toEqual(Object.values(placement).map((pieces) => pieces.join("、")));
});

test("四人将棋の遊び方ダイアログは従来どおりh3と説明文を表示する", () => {
  render(
    <MemoryRouter>
      <HowToPlayDialog game="four-shogi" onClose={() => {}} />
    </MemoryRouter>,
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  const headings = [...dialog.querySelectorAll("section h3")].map((heading) => heading.textContent);
  expect(headings).toEqual([
    "4つの方向から指す将棋",
    "取った駒を使い、駒を成る",
    "王手を受けた人の手番を優先",
    "シングルスとダブルス",
    "三人攻撃禁止はON／OFFを切り替え可能",
    "引き分けと持ち時間",
  ]);
  expect([...dialog.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
    "四人将棋の遊び方",
  ]);
  expect(dialog.querySelectorAll('svg[role="img"]')).toHaveLength(0);
  expect(dialog.textContent).toContain("四人将棋の遊び方");
  expect(dialog.textContent).toContain("同じ局面が4回現れると、連続王手でも引き分けです。");
  expect(
    [...dialog.querySelectorAll("button")].some((button) => button.textContent === "わかった"),
  ).toBe(true);

  const initial = document.implementation.createHTMLDocument();
  initial.body.innerHTML = renderFourShogiRules(
    '<title>TetraBoard</title><div id="root"></div>',
    lobbyBoardSources,
    resolveRulesDiagramAsset,
  );
  const rulesHeadings = [...initial.querySelectorAll("main section h2")].slice(3, -2);
  expect(rulesHeadings.map((heading) => heading.textContent)).toEqual(headings);
  expect(
    rulesHeadings.flatMap((heading) =>
      [...heading.parentElement!.querySelectorAll("p")].map((paragraph) => paragraph.textContent),
    ),
  ).toEqual(
    [...dialog.querySelectorAll("section h3")].flatMap((heading) =>
      [...heading.parentElement!.querySelectorAll("p")].map((paragraph) => paragraph.textContent),
    ),
  );
});

test("ロビーとルールを往復すると先頭へ戻り、共通ナビとメタ情報を表示する", async () => {
  const lobbyPath = gameCatalog["four-shogi"].lobbyPath;
  const router = createMemoryRouter(
    [
      {
        Component: AccountLayout,
        children: [
          { path: lobbyPath, element: <GameIntroduction game="four-shogi" /> },
          {
            path: fourShogiRulesPath,
            lazy: () => import("../src/features/lobby/fourShogiRulesRoute"),
          },
          { path: "/tournaments", element: <div /> },
          { path: "/terms", element: <div /> },
        ],
      },
    ],
    { initialEntries: [lobbyPath] },
  );
  const previousHead = document.head.innerHTML;
  const stop = startPageMetadata(router);
  const scrollTo = spyOn(window, "scrollTo");
  try {
    const view = render(<RouterProvider router={router} />);
    expect(scrollTo).toHaveBeenCalledTimes(0);
    requests.find((request) => request.url === "/api/account/session")!.respond({ user: profile });
    await flush();
    await act(async () =>
      view.querySelector<HTMLAnchorElement>(`a[href="${fourShogiRulesPath}"]`)!.click(),
    );
    expect(router.state.location.pathname).toBe(fourShogiRulesPath);
    expect(view.querySelector("h1")?.textContent).toBe("四人将棋のルール");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    const desktop = view.querySelector('[aria-label="メインナビゲーション"]')!;
    const mobile = view.querySelector('[aria-label="下部ナビゲーション"]')!;
    expect(desktop.querySelector(`a[href="${lobbyPath}"]`)?.textContent).toBe("四人将棋");
    expect(mobile.textContent).toContain("アカウント");
    expect(view.querySelector('button[aria-label="表示・サウンド設定"]')).toBeTruthy();
    expect(view.querySelector('button[aria-label$="のアカウントメニュー"]')).toBeTruthy();
    const initial = document.implementation.createHTMLDocument();
    initial.documentElement.innerHTML = renderFourShogiRules(
      '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>',
      lobbyBoardSources,
      resolveRulesDiagramAsset,
    );
    const sections = [...view.querySelectorAll("main > section")].slice(-2);
    expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
      "勝ち方のコツ",
      "よくある質問",
    ]);
    expect(sections.map((section) => section.outerHTML)).toEqual(
      [...initial.querySelectorAll("main > section")].slice(-2).map((section) => section.outerHTML),
    );
    const tournamentLink = view.querySelector<HTMLAnchorElement>('main a[href="/tournaments"]')!;
    expect(tournamentLink.textContent).toBe("大会の日程と結果");
    expect(tournamentLink.outerHTML).toBe(
      initial.querySelector('main a[href="/tournaments"]')!.outerHTML,
    );
    expect(document.title).toBe(initial.title);
    expect(readSocialTags(document.head.innerHTML)).toEqual(readSocialTags(initial.head.innerHTML));
    for (const [selector, attribute] of [
      ['meta[name="description"]', "content"],
      ['meta[name="robots"]', "content"],
      ['link[rel="canonical"]', "href"],
    ]) {
      expect(document.head.querySelector(selector!)?.getAttribute(attribute!)).toBe(
        initial.head.querySelector(selector!)!.getAttribute(attribute!),
      );
    }
    const playLink = [...view.querySelectorAll("a")].find(
      (link) => link.textContent === "四人将棋で遊ぶ",
    )!;
    await act(async () => playLink.click());
    expect(router.state.location.pathname).toBe(lobbyPath);
    expect(document.title).toContain("四人将棋（4人将棋）を");
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    await act(async () => router.navigate(-1));
    await act(async () => router.navigate("/terms"));
    expect(scrollTo).toHaveBeenCalledTimes(2);
    await act(async () => router.navigate(-1));
    expect(router.state.location.pathname).toBe(fourShogiRulesPath);
    await act(async () =>
      view.querySelector<HTMLAnchorElement>('main a[href="/tournaments"]')!.click(),
    );
    expect(router.state.location.pathname).toBe("/tournaments");
  } finally {
    scrollTo.mockRestore();
    stop();
    router.dispose();
    document.head.innerHTML = previousHead;
  }
});

test("全公開ロビーの初期HTMLと画面内遷移は同じtitle・description・OGPを持つ", async () => {
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
      expect(readSocialTags(document.head.innerHTML)).toEqual(
        readSocialTags(initial.head.innerHTML),
      );
    }
  } finally {
    document.head.innerHTML = previousHead;
  }
});

test("初期HTMLのJSON-LDは初回表示で残り、ルームへ移動すると消える", async () => {
  const template = await Bun.file(new URL("../index.html", import.meta.url)).text();
  const previousHead = document.head.innerHTML;
  for (const [path, html] of [
    ["/", renderGeneralLobby(template, lobbyBoardSources)],
    [
      gameCatalog["four-shogi"].lobbyPath,
      renderPublicLobby(template, "four-shogi", lobbyBoardSources),
    ],
    [
      fourShogiRulesPath,
      renderFourShogiRules(template, lobbyBoardSources, resolveRulesDiagramAsset),
    ],
  ] as const) {
    const initial = document.implementation.createHTMLDocument();
    initial.documentElement.innerHTML = html;
    document.head.innerHTML = initial.head.innerHTML;
    const jsonLd = document.head.querySelector(jsonLdSelector);
    expect(jsonLd).not.toBeNull();
    const router = createMemoryRouter([{ path: "*", element: <div /> }], {
      initialEntries: [path],
    });
    const stop = startPageMetadata(router);
    try {
      expect(document.head.querySelector(jsonLdSelector)).toBe(jsonLd);
      await router.navigate("/rooms/example");
      expect(document.head.querySelector(jsonLdSelector)).toBeNull();
      await router.navigate(-1);
      expect(document.head.querySelector(jsonLdSelector)).toBeNull();
    } finally {
      stop();
      router.dispose();
      document.head.innerHTML = previousHead;
    }
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

test.each([
  ["/games/four-shogi", "four-shogi", "四人将棋"],
  ["/tournaments", "tournaments", "大会一覧"],
  [fourShogiRulesPath, "four-shogi-rules", "四人将棋のルール"],
] as const)(
  "初期HTMLは遅延ルートの準備後に一度だけ置き換わる %s",
  async (path, marker, heading) => {
    let resolve!: (value: { Component: () => null }) => void;
    const router = createMemoryRouter(
      [
        {
          path,
          lazy: () =>
            new Promise((r) => {
              resolve = r;
            }),
        },
      ],
      { initialEntries: [path] },
    );
    const root = document.createElement("div");
    root.dataset.publicLobby = marker;
    root.innerHTML = `<h1>${heading}</h1><p data-startup-status role="status">読み込み中</p>`;
    let mounts = 0;
    startPublicLobby(root, router, () => {
      mounts++;
      root.replaceChildren(document.createTextNode("対局画面"));
    });
    expect(mounts).toBe(0);
    expect(root.textContent).toContain(heading);
    resolve({ Component: () => null });
    await flush();
    expect(mounts).toBe(1);
    expect(root.dataset.publicLobby).toBeUndefined();
    expect(root.textContent).toBe("対局画面");
    await router.revalidate();
    expect(mounts).toBe(1);
    router.dispose();
  },
);

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

test("ルールの初回チャンク取得が失敗しても初期HTMLとメタ情報を保持する", async () => {
  let reject!: (reason: Error) => void;
  const router = createMemoryRouter(
    [
      {
        path: fourShogiRulesPath,
        lazy: () =>
          new Promise((_, r) => {
            reject = r;
          }),
      },
    ],
    { initialEntries: [fourShogiRulesPath] },
  );
  const initial = document.implementation.createHTMLDocument();
  initial.documentElement.innerHTML = renderFourShogiRules(
    '<html><head><title>TetraBoard</title></head><body><div id="root"></div></body></html>',
    lobbyBoardSources,
    resolveRulesDiagramAsset,
  );
  const root = initial.getElementById("root")!;
  const previousHead = document.head.innerHTML;
  document.head.innerHTML = initial.head.innerHTML;
  const deliveredHead = document.head.innerHTML;
  const deliveredBody = root.innerHTML;
  const stop = startPageMetadata(router, root);
  try {
    let mounted = false;
    startPublicLobby(root, router, () => {
      mounted = true;
    });
    expect(document.head.innerHTML).toBe(deliveredHead);
    reject(new Error("chunk unavailable"));
    await flush();
    expect(router.state.initialized).toBe(true);
    expect(Boolean(router.state.errors)).toBe(true);
    expect(mounted).toBe(false);
    expect(root.innerHTML).toBe(deliveredBody);
    expect(document.head.innerHTML).toBe(deliveredHead);
  } finally {
    stop();
    router.dispose();
    document.head.innerHTML = previousHead;
  }
});
