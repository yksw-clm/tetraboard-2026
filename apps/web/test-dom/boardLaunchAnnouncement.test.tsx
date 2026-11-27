import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import type { AccountProfile } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { AccountContext } from "../src/features/account/useAccount";
import { readRegistrationReturn } from "../src/features/account/registrationReturn";
import { FourGomokuLobbyPage } from "../src/features/lobby/FourGomokuLobbyPage";
import { FourReversiLobbyPage } from "../src/features/lobby/FourReversiLobbyPage";
import { FourShogiLobbyPage } from "../src/features/lobby/FourShogiLobbyPage";
import { GeneralLobbyPage } from "../src/features/lobby/GeneralLobbyPage";
import { GomokuLobbyPage } from "../src/features/lobby/GomokuLobbyPage";
import { importLobbyPostPreview } from "../src/features/lobby/importLobbyPostPreview";
import { ReversiLobbyPage } from "../src/features/lobby/ReversiLobbyPage";
import { ShogiLobbyPage } from "../src/features/lobby/ShogiLobbyPage";
import { profile } from "../test/fixtures/account";
import { guestProfile } from "./guestAccountFixtures";
import { act, clock, flush, press, render, requests, rerender } from "./harness";

const seenKey = "tetraboard:board-launch:seen";
const title = "掲示板を公開しました！";
const pages = {
  "four-gomoku": FourGomokuLobbyPage,
  "four-reversi": FourReversiLobbyPage,
  "four-shogi": FourShogiLobbyPage,
  gomoku: GomokuLobbyPage,
  reversi: ReversiLobbyPage,
  shogi: ShogiLobbyPage,
};
const account = { user: null, loading: false, error: null, refresh: async () => {}, update() {} };
const announcement = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) =>
    dialog.textContent?.includes(title),
  );
const previewRequests = () =>
  requests.filter(({ url }) => url === "/api/games/shogi/posts?includeAttachments=1");
const timeline = (acceptingPosts: boolean) => ({
  posts: [],
  acceptingPosts,
  postingStopped: false,
  availableAtMs: 0,
  serverTimeMs: Date.now(),
  nextCursor: null,
});

beforeAll(async () => {
  await Promise.all([importLobbyPostPreview(), import("../src/features/lobby/BoardLaunchDialog")]);
});
let foreground: ReturnType<typeof spyOn<typeof document, "hasFocus">>;
const initialVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
beforeEach(() => {
  foreground = spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  foreground.mockRestore();
  if (initialVisibility) Object.defineProperty(document, "visibilityState", initialVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

function showLobby(entry = "/games/shogi", user: AccountProfile | null = null) {
  const router = createMemoryRouter(
    [
      { path: "/", Component: GeneralLobbyPage },
      ...gameIds.map((game) => ({ path: gameCatalog[game].lobbyPath, Component: pages[game] })),
      { path: "/games/:game/posts", element: <h1>タイムライン</h1> },
    ],
    { initialEntries: [entry] },
  );
  const view = render(
    <AccountContext value={{ ...account, user }}>
      <RouterProvider router={router} />
    </AccountContext>,
  );
  return { router, view };
}

async function settle() {
  await flush();
  clock.advance(0);
  await flush();
}

test("総合ロビーでは案内の受付確認を行わず、表示済みにしない", async () => {
  showLobby("/");
  await settle();
  expect(requests.some(({ url }) => url.startsWith("/api/games/") && url.includes("/posts"))).toBe(
    false,
  );
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBeNull();
});

test.each([...gameIds])("%s はプレビューの応答から案内し、自分の掲示板を開ける", async (game) => {
  localStorage.setItem("tetraboard:rated-launch:seen", "1");
  const { router } = showLobby(gameCatalog[game].lobbyPath, {
    ...profile,
    profileCompleted: false,
  });
  await settle();
  const path = `${gameCatalog[game].lobbyPath}/posts`;
  const boardRequests = requests.filter(({ url }) => url.startsWith(`/api${path}?`));
  expect(boardRequests.map(({ url }) => url)).toEqual([`/api${path}?includeAttachments=1`]);
  boardRequests[0]!.respond(timeline(true));
  await settle();

  const link = announcement()!.querySelector("a")!;
  expect(link.textContent).toBe("さっそく投稿してみる");
  expect(link.getAttribute("href")).toBe(path);
  expect(announcement()!.textContent).not.toContain("Googleで続ける");
  await act(async () => link.click());
  expect(router.state.location.pathname).toBe(path);
  expect(announcement()).toBeUndefined();
});

test("他のタブで表示済みになったら、受付確認中のタブと次のゲームロビーでは表示しない", async () => {
  const { router } = showLobby();
  await settle();
  expect(localStorage.getItem(seenKey)).toBeNull();

  localStorage.setItem(seenKey, "1");
  act(() =>
    window.dispatchEvent(new window.StorageEvent("storage", { key: seenKey, newValue: "1" })),
  );
  previewRequests()[0]!.respond(timeline(true));
  await settle();
  expect(announcement()).toBeUndefined();

  await act(async () => router.navigate("/games/gomoku"));
  await settle();
  requests
    .find(({ url }) => url === "/api/games/gomoku/posts?includeAttachments=1")!
    .respond(timeline(true));
  await settle();
  expect(announcement()).toBeUndefined();
});

test.each([
  {
    accountType: "匿名",
    user: null,
    provider: "google",
    button: "Googleで続ける",
    redirect: "https://accounts.google.com/o/oauth2/auth",
  },
  {
    accountType: "ゲスト",
    user: guestProfile(),
    provider: "discord",
    button: "Discordで続ける",
    redirect: "https://discord.com/oauth2/authorize",
  },
])(
  "$accountType の $provider 連携は同じゲームへの復帰先を保存し、失敗時に再試行できる",
  async ({ user, provider, button, redirect }) => {
    showLobby("/games/shogi", user);
    await settle();
    previewRequests()[0]!.respond(timeline(true));
    await settle();
    const dialog = announcement()!;
    expect([...dialog.querySelectorAll("p")].map((node) => node.textContent)).toContain(
      "ユーザー登録をして投稿してみる",
    );
    expect([...dialog.querySelectorAll("button")].map((node) => node.textContent)).toContain(
      "Googleで続ける",
    );
    expect([...dialog.querySelectorAll("button")].map((node) => node.textContent)).toContain(
      "Discordで続ける",
    );
    expect([...dialog.querySelectorAll("a")].map((node) => node.getAttribute("href"))).toEqual([
      "/terms",
      "/privacy",
    ]);
    expect(dialog.textContent).toContain("利用規約に同意し");

    const signInRequests = () => requests.filter(({ url }) => url === "/api/auth/sign-in/social");
    press(dialog, button);
    press(dialog, button);
    await settle();
    expect(signInRequests()).toHaveLength(1);
    expect(JSON.parse(String(signInRequests()[0]!.init.body))).toMatchObject({
      provider,
      analytics: { entry: "account-link", game: "shogi" },
    });
    expect(new Headers(signInRequests()[0]!.init.headers).get("X-Legal-Consent")).toBe(
      legalVersion,
    );
    expect(readRegistrationReturn()).toMatchObject({
      path: "/games/shogi/posts",
      oauthStarted: true,
    });
    const busyButtons = [...announcement()!.querySelectorAll("button")];
    expect(busyButtons).toHaveLength(4);
    expect(busyButtons.every((node) => node.disabled)).toBe(true);
    signInRequests()[0]!.respond({ message: "接続できませんでした" }, 503);
    await settle();
    expect(announcement()?.querySelector('[role="alert"]')?.textContent).toBe(
      "接続できませんでした",
    );
    expect(readRegistrationReturn()).toMatchObject({
      path: "/games/shogi/posts",
      oauthStarted: false,
    });

    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      press(announcement()!, button);
      await settle();
      signInRequests()[1]!.respond({ url: redirect });
      await settle();
      expect(assign).toHaveBeenCalledWith(redirect);
      expect(readRegistrationReturn()).toMatchObject({
        path: "/games/shogi/posts",
        oauthStarted: true,
      });
    } finally {
      assign.mockRestore();
    }
  },
);

test.each([200, 503])("停止中・取得失敗（%i）は後の訪問で受付を確認できる", async (status) => {
  const { view } = showLobby();
  await settle();
  previewRequests()[0]!.respond(timeline(false), status);
  await settle();
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBeNull();

  rerender(view, null);
  showLobby();
  await settle();
  previewRequests()[1]!.respond(timeline(true));
  await settle();
  press(announcement()!, "あとで");
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBe("1");
});

test("受付確認待ちにルーム作成を押すと案内を出さず、既読にもならない", async () => {
  const { view } = showLobby();
  await settle();
  const first = previewRequests()[0]!;
  press(view, "公開ルームを作る");
  first.respond(timeline(true));
  await settle();

  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("ルームを作る");
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBeNull();
});

test.each(["ロビーを離れる", "公開ルームを作る"] as const)(
  "案内の表示予約と同じバッチで「%s」ときは既読を保存しない",
  async (action) => {
    const { view } = showLobby();
    await settle();
    previewRequests()[0]!.respond(timeline(true));
    await flush();

    act(() => {
      clock.advance(0);
      expect(announcement()).toBeUndefined();
      if (action === "ロビーを離れる") rerender(view, null);
      else press(view, action);
    });

    if (action === "公開ルームを作る")
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("ルームを作る");
    expect(announcement()).toBeUndefined();
    expect(localStorage.getItem(seenKey)).toBeNull();
  },
);

test("レート戦付きで開いた訪問は未読のまま既存ダイアログを利用できる", async () => {
  showLobby("/games/shogi?matchmaking=1");
  await settle();
  requests
    .find(({ url }) => url.startsWith("/api/matchmaking/shogi?"))!
    .respond({
      status: "idle",
      enabled: true,
      serverNowMs: Date.now(),
    });
  requests
    .find(({ url }) => url === "/api/games/shogi/posts?includeAttachments=1")!
    .respond(timeline(true));
  await settle();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("アカウントを連携して、レート戦に挑戦！");
  press(dialog, "戻る");
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(localStorage.getItem(seenKey)).toBeNull();
});

test("フォーカスがない間と非表示中は開かず、利用できる画面に戻ってから案内する", async () => {
  showLobby();
  await settle();
  const first = previewRequests()[0]!;
  foreground.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("blur")));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  first.respond(timeline(true));
  await settle();
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBeNull();

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await settle();
  expect(announcement()).toBeUndefined();
  expect(previewRequests()).toHaveLength(1);
  foreground.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event("focus")));
  await settle();
  expect(announcement()).toBeDefined();
  const close = announcement()!.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!;
  act(() => close.click());
  await settle();
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBe("1");
});
