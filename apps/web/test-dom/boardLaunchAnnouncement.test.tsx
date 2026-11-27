import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { AccountContext } from "../src/features/account/useAccount";
import { FourGomokuLobbyPage } from "../src/features/lobby/FourGomokuLobbyPage";
import { FourReversiLobbyPage } from "../src/features/lobby/FourReversiLobbyPage";
import { FourShogiLobbyPage } from "../src/features/lobby/FourShogiLobbyPage";
import { GeneralLobbyPage } from "../src/features/lobby/GeneralLobbyPage";
import { GomokuLobbyPage } from "../src/features/lobby/GomokuLobbyPage";
import { importLobbyPostPreview } from "../src/features/lobby/importLobbyPostPreview";
import { ReversiLobbyPage } from "../src/features/lobby/ReversiLobbyPage";
import { ShogiLobbyPage } from "../src/features/lobby/ShogiLobbyPage";
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
const homeRequests = () => requests.filter(({ url }) => url.endsWith("/posts?limit=1"));
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

function showLobby(entry: string | { pathname: string; state: object } = "/") {
  const router = createMemoryRouter(
    [
      { path: "/", Component: GeneralLobbyPage },
      ...gameIds.map((game) => ({ path: gameCatalog[game].lobbyPath, Component: pages[game] })),
      { path: "/games/:game/posts", element: <h1>タイムライン</h1> },
    ],
    { initialEntries: [entry] },
  );
  const view = render(
    <AccountContext value={account}>
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

test("総合は旧レート戦の既読に関係なく、受付確認後に6ゲームの掲示板へのリンクを表示する", async () => {
  localStorage.setItem("tetraboard:rated-launch:seen", "1");
  const { router, view } = showLobby();
  await settle();
  expect(homeRequests()).toHaveLength(1);
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBeNull();
  homeRequests()[0]!.respond(timeline(true));
  await settle();

  clock.advance(32);
  await flush();
  const links = [...announcement()!.querySelectorAll("a")];
  expect(links.map((link) => link.textContent).sort()).toEqual(
    gameIds.map((game) => gameCatalog[game].name).sort(),
  );
  expect(links.map((link) => link.getAttribute("href")).sort()).toEqual(
    gameIds.map((game) => `${gameCatalog[game].lobbyPath}/posts`).sort(),
  );
  await act(async () => links.find((link) => link.textContent === "将棋")!.click());
  expect(router.state.location.pathname).toBe("/games/shogi/posts");
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBe("1");
  rerender(view, null);
  showLobby();
  await settle();
  expect(homeRequests()).toHaveLength(1);
  expect(announcement()).toBeUndefined();
});

test.each([...gameIds])("%s はプレビューの応答から案内し、自分の掲示板を開ける", async (game) => {
  const { router } = showLobby(gameCatalog[game].lobbyPath);
  await settle();
  const path = `${gameCatalog[game].lobbyPath}/posts`;
  const boardRequests = requests.filter(({ url }) => url.startsWith(`/api${path}?`));
  expect(boardRequests.map(({ url }) => url)).toEqual([`/api${path}?includeAttachments=1`]);
  boardRequests[0]!.respond(timeline(true));
  await settle();

  const link = announcement()!.querySelector("a")!;
  expect(link.textContent).toBe("掲示板を見る");
  expect(link.getAttribute("href")).toBe(path);
  await act(async () => link.click());
  expect(router.state.location.pathname).toBe(path);
  expect(announcement()).toBeUndefined();
});

test.each([200, 503])("停止中・取得失敗（%i）は後の訪問で受付を確認できる", async (status) => {
  const { view } = showLobby();
  await settle();
  homeRequests()[0]!.respond(timeline(false), status);
  await settle();
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBeNull();

  rerender(view, null);
  showLobby();
  await settle();
  homeRequests()[1]!.respond(timeline(true));
  await settle();
  press(announcement()!, "あとで");
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBe("1");
});

test("受付確認待ちにルーム作成を押すと案内を出さず、既読にもならない", async () => {
  const { view } = showLobby();
  await settle();
  const first = homeRequests()[0]!;
  press(view, "ルームを作る");
  first.respond(timeline(true));
  await settle();

  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("ゲームを選択");
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBeNull();
});

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
  const first = homeRequests()[0]!;
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
  expect(homeRequests()).toHaveLength(1);
  foreground.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event("focus")));
  await settle();
  homeRequests()[1]!.respond(timeline(true));
  await settle();
  expect(announcement()).toBeDefined();
  const close = announcement()!.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!;
  act(() => close.click());
  await settle();
  expect(announcement()).toBeUndefined();
  expect(localStorage.getItem(seenKey)).toBe("1");
});
