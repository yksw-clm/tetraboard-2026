import { expect, test } from "bun:test";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { readRegistrationReturn } from "../src/features/account/registrationReturn";
import { AppHeader } from "../src/shared/ui/AppHeader";
import { AppNavigation, LastLobbyGameTracker } from "../src/shared/ui/AppNavigation";
import { lastLobbyGame, lastLobbyGameKey } from "../src/shared/lastLobbyGame";
import { HowToPlayPage } from "../src/features/help/HowToPlayPage";
import { updatePageMetadata } from "../src/seo/pageMetadata";
import { profile } from "../test/fixtures/account";
import { AccountLayout } from "../src/features/account/AccountSession";
import { guestProfile } from "./guestAccountFixtures";
import { act, flush, render, requests, rerender, wrap } from "./harness";

test("ヘッダーと下タブは共通の移動先・現在地・直近ゲームを遷移と戻る操作で保つ", async () => {
  lastLobbyGame.sync(null);
  const router = createMemoryRouter([
    {
      element: (
        <>
          <LastLobbyGameTracker />
          <AppHeader homeTo="/" homeLabel="TetraBoard ホーム" />
          <Outlet />
        </>
      ),
      children: [{ path: "*", element: <div /> }],
    },
  ]);
  const view = render(<RouterProvider router={router} />);
  const nav = () => view.querySelector<HTMLElement>('[aria-label="メインナビゲーション"]')!;
  const mobile = () => view.querySelector<HTMLElement>('[aria-label="下部ナビゲーション"]')!;
  try {
    expect(nav().querySelectorAll("a")).toHaveLength(3);
    expect(mobile().querySelectorAll("a")).toHaveLength(4);
    expect(nav().querySelector('a[aria-current="page"]')!.textContent).toBe("ホーム");
    expect(nav().querySelector('a[href="/games/four-reversi"]')).not.toBeNull();
    act(() => void router.navigate("/games/four-shogi"));
    await flush();
    expect(nav().querySelector('a[aria-current="page"]')!.textContent).toBe("四人将棋");
    expect(localStorage.getItem(lastLobbyGameKey)).toBe("four-shogi");
    act(() => mobile().querySelector<HTMLAnchorElement>('a[href="/how-to-play"]')!.click());
    await flush();
    expect(router.state.location.pathname).toBe("/how-to-play");
    expect(nav().querySelector('a[aria-current="page"]')!.textContent).toBe("遊び方");
    expect(nav().querySelector('a[href="/games/four-shogi"]')).not.toBeNull();
    act(() => void router.navigate("/games/gomoku"));
    await flush();
    act(() => void router.navigate(-1));
    await flush();
    expect(nav().querySelector('a[href="/games/gomoku"]')).not.toBeNull();
    act(() =>
      window.dispatchEvent(
        new window.StorageEvent("storage", { key: lastLobbyGameKey, newValue: "shogi" }),
      ),
    );
    expect(nav().querySelector('a[href="/games/shogi"]')).not.toBeNull();
    act(() =>
      window.dispatchEvent(
        new window.StorageEvent("storage", { key: lastLobbyGameKey, newValue: "broken" }),
      ),
    );
    expect(nav().querySelector('a[href="/games/four-reversi"]')).not.toBeNull();
  } finally {
    router.dispose();
  }
});

test("下タブのアカウントは登録者・ゲスト・設定前・未認証で既存の入口へ進む", async () => {
  for (const [user, to] of [
    [profile, "/account"],
    [guestProfile(), "/account"],
    [{ ...profile, profileCompleted: false }, "/account/setup"],
    [null, "/login"],
  ] as const) {
    const view = render(wrap(user, "/games/shogi")(<AppNavigation mobile />));
    const link = [...view.querySelectorAll<HTMLAnchorElement>("a")].find(
      (item) => item.textContent === "アカウント",
    )!;
    expect(link.getAttribute("href")).toBe(to);
    if (!user) {
      act(() => link.click());
      await flush();
      expect(readRegistrationReturn()?.path).toBe("/games/shogi");
    }
  }
});

test("下タブは未認証・画像なし登録者・ゲストに従来の仮アイコンを表示する", () => {
  const images: HTMLImageElement[] = [];
  const NativeImage = window.Image;
  window.Image = class extends NativeImage {
    constructor(width?: number, height?: number) {
      super(width, height);
      images.push(this);
    }
  };
  try {
    for (const user of [
      null,
      profile,
      guestProfile(),
      { ...guestProfile(), avatarUrl: "/api/avatars/guest-image" },
    ]) {
      const view = render(wrap(user)(<AppNavigation mobile />));
      const link = [...view.querySelectorAll<HTMLAnchorElement>("a")].find(
        (item) => item.textContent === "アカウント",
      )!;
      expect(link.querySelector("img")).toBeNull();
      expect(link.querySelector("svg")).not.toBeNull();
      expect(link.getAttribute("href")).toBe(user ? "/account" : "/login");
    }
    expect(images).toHaveLength(0);
  } finally {
    window.Image = NativeImage;
  }
});

test("下タブの本人画像は画像変更とアカウント切替に追従し、ラベル・現在地・PCを保つ", async () => {
  const images: HTMLImageElement[] = [];
  const NativeImage = window.Image;
  window.Image = class extends NativeImage {
    constructor(width?: number, height?: number) {
      super(width, height);
      images.push(this);
    }
  };
  const navigation = (
    <>
      <AppNavigation />
      <AppNavigation mobile />
    </>
  );
  const first = { ...profile, avatarUrl: "/api/avatars/first-image" };
  const changed = { ...first, avatarUrl: "/api/avatars/changed-image" };
  const other = { ...first, username: "another_member", avatarUrl: "/api/avatars/other-image" };
  try {
    const view = render(wrap(first, "/account")(navigation));
    const accountLink = () =>
      view.querySelector<HTMLAnchorElement>(
        '[aria-label="下部ナビゲーション"] a[href="/account"]',
      )!;
    const originalLink = accountLink();
    let previousUrl: string | undefined;
    for (const user of [first, changed, other]) {
      rerender(view, wrap(user, "/account")(navigation));
      if (previousUrl) expect(accountLink().querySelector(`img[src="${previousUrl}"]`)).toBeNull();
      const pending = images.at(-1)!;
      expect(pending.src).toBe(new URL(user.avatarUrl, window.location.href).href);
      Object.defineProperties(pending, {
        complete: { value: true },
        naturalWidth: { value: 32 },
      });
      act(() => pending.dispatchEvent(new Event("load")));
      await flush();
      const image = accountLink().querySelector("img")!;
      expect(image.getAttribute("src")).toBe(user.avatarUrl);
      expect(image.getAttribute("alt")).toBe("");
      expect(accountLink()).toBe(originalLink);
      expect(accountLink().textContent).toBe("アカウント");
      expect(accountLink().getAttribute("aria-current")).toBe("page");
      expect(
        view.querySelector('[aria-label="メインナビゲーション"] img[src^="/api/avatars/"]'),
      ).toBeNull();
      previousUrl = user.avatarUrl;
    }
    for (const user of [{ ...guestProfile(), avatarUrl: first.avatarUrl }, null, profile]) {
      const count = images.length;
      rerender(view, wrap(user, "/account")(navigation));
      const link = view.querySelector<HTMLAnchorElement>(
        '[aria-label="下部ナビゲーション"] a:last-child',
      )!;
      expect(link.querySelector("img")).toBeNull();
      expect(link.querySelector("svg")).not.toBeNull();
      expect(link.textContent).toBe("アカウント");
      expect(link.getAttribute("aria-current")).toBe("page");
      expect(link.getAttribute("href")).toBe(user ? "/account" : "/login");
      expect(images).toHaveLength(count);
    }
  } finally {
    window.Image = NativeImage;
  }
});

test("対局・観戦・公開棋譜・本人棋譜では固定下タブを表示しない", () => {
  for (const path of [
    "/rooms/12345",
    "/rooms/12345?watch=1",
    "/matches/example",
    "/account/matches/example",
  ]) {
    const view = render(wrap(null, path)(<AppNavigation mobile />));
    expect(view.querySelector("nav")).toBeNull();
  }
});

test("遊び方ページは空の本文とナビを持ち、検索対象外のタイトルへ切り替わる", () => {
  const previousHead = document.head.innerHTML;
  try {
    const view = render(wrap(null, "/how-to-play/")(<HowToPlayPage />));
    expect(view.querySelector('main[aria-label="遊び方"]')!.childNodes).toHaveLength(0);
    expect(view.querySelector('[aria-label="下部ナビゲーション"]')).not.toBeNull();
    expect(
      view.querySelector('[aria-label="メインナビゲーション"] a[aria-current="page"]')!.textContent,
    ).toBe("遊び方");
    updatePageMetadata("/games/shogi");
    updatePageMetadata("/how-to-play/");
    expect(document.title).toBe("遊び方 | TetraBoard");
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')!.content).toBe(
      "noindex,follow",
    );
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
  } finally {
    document.head.innerHTML = previousHead;
  }
});

test("末尾スラッシュ付きの遊び方もプロフィール未設定のまま閲覧できる", async () => {
  const router = createMemoryRouter(
    [
      {
        element: <AccountLayout />,
        children: [
          { path: "/how-to-play", element: <HowToPlayPage /> },
          { path: "/account/setup", element: <p>初回プロフィール設定</p> },
        ],
      },
    ],
    { initialEntries: ["/how-to-play/"] },
  );
  const view = render(<RouterProvider router={router} />);
  try {
    requests
      .find((request) => request.url === "/api/account/session")!
      .respond({ user: { ...profile, profileCompleted: false } });
    await flush();
    expect(router.state.location.pathname).toBe("/how-to-play/");
    expect(view.querySelector('main[aria-label="遊び方"]')).not.toBeNull();
    expect(view.textContent).not.toContain("初回プロフィール設定");
  } finally {
    router.dispose();
  }
});
