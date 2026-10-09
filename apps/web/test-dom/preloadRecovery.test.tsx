import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { lazy, StrictMode, type ReactElement } from "react";
import {
  createBrowserRouter,
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
} from "react-router";
import { AppErrorPage, AppRouteErrorPage } from "../src/shared/ui/AppErrorPage";
import {
  createPreloadRecovery,
  preloadRecovery,
  preloadRecoveryMessage,
  unexpectedErrorMessage,
} from "../src/shared/preloadRecovery";
import { RoomErrorPage, RoomPage } from "../src/features/room/RoomPage";
import { AccountContext } from "../src/features/account/useAccount";
import { MatchReplayErrorPage, MatchReplayPage } from "../src/features/room/MatchReplayPage";
import { liveViews } from "../src/features/room/liveViews";
import { replayViews } from "../src/features/room/replayViews";
import { matchReplayLoader, replayLoaders } from "../src/features/room/matchReplayLoader";
import { startPublicLobby } from "../src/seo/startPublicLobby";
import { waitingRoom } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { replayMatch } from "../test/fixtures/matchReplayFixtures";
import { shogiReplayMatch } from "../test/fixtures/fourShogiRecordFixtures";
import { act, flush, press, render, requests } from "./harness";

const restores: (() => void)[] = [];
const reload = mock(() => window.location.href);
beforeEach(() => {
  reload.mockClear();
  window.history.replaceState(null, "", "/");
  restores.push(preloadRecovery.listen(window));
  const recovery = createPreloadRecovery({ reload });
  const automatic = spyOn(preloadRecovery, "tryAutoReload").mockImplementation(
    recovery.tryAutoReload,
  );
  const manual = spyOn(preloadRecovery, "reload").mockImplementation(reload);
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  restores.push(
    () => automatic.mockRestore(),
    () => manual.mockRestore(),
    () => consoleError.mockRestore(),
  );
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function notify(error: unknown) {
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.assign(event, { payload: error });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
}

function replaceProperty<T, K extends keyof T>(object: T, key: K, value: T[K]) {
  const original = object[key];
  object[key] = value;
  restores.push(() => {
    object[key] = original;
  });
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  test(`${game}への遷移失敗はイベント時点で更新せず、移動先URL確定後に一度更新`, async () => {
    window.history.replaceState(null, "", "/rooms/12345");
    const error = new Error("Failed to fetch dynamically imported module: private chunk URL");
    let reject!: (reason: Error) => void;
    const router = createBrowserRouter(
      [
        {
          ErrorBoundary: AppRouteErrorPage,
          children: [
            { path: "/rooms/:id", element: <p>ルーム</p> },
            {
              path: `/games/${game}`,
              lazy: () =>
                new Promise((_, fail) => {
                  reject = fail;
                }),
            },
          ],
        },
      ],
      { window },
    );
    restores.push(() => router.dispose());
    const view = render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
    const target = `/games/${game}?source=room#lobby`;
    let navigation!: Promise<void>;
    act(() => {
      navigation = router.navigate(target);
    });
    notify(error);
    notify(error);
    expect(reload).not.toHaveBeenCalled();
    reject(error);
    await act(async () => {
      await navigation;
    });
    await flush();
    expect(reload.mock.results.map((result) => result.value)).toEqual([
      `https://tetraboard.test${target}`,
    ]);
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(preloadRecoveryMessage);
    expect(view.textContent).not.toContain("private chunk URL");
    expect(view.textContent).not.toContain("Unexpected Application Error");
  });
}

test("文書を作り直しても自動更新の上限を保持し、手動更新や別ビルドでも解除しない", () => {
  sessionStorage.setItem("tetraboard:room:12345:membership", "saved membership");
  const firstDocument = createPreloadRecovery({ reload });
  firstDocument.tryAutoReload();
  firstDocument.tryAutoReload();
  expect(reload).toHaveBeenCalledTimes(1);
  const nextDocument = createPreloadRecovery({ reload });
  nextDocument.tryAutoReload();
  expect(reload).toHaveBeenCalledTimes(1);
  nextDocument.reload();
  createPreloadRecovery({ reload }).tryAutoReload();
  expect(reload).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem("tetraboard:room:12345:membership")).toBe("saved membership");
});

test("保存領域の取得・読取・書込に失敗した場合は自動更新しない", () => {
  const denied = () => {
    throw new Error("storage denied");
  };
  for (const getStorage of [
    denied,
    () => ({ getItem: denied, setItem: mock() }),
    () => ({ getItem: () => null, setItem: denied }),
  ]) {
    const recovery = createPreloadRecovery({ getStorage, reload });
    recovery.tryAutoReload();
    recovery.tryAutoReload();
    expect(reload).not.toHaveBeenCalled();
  }
});

test("CSS preload失敗の再発では案内を表示し、再読み込みボタンは現在URLを保持", () => {
  createPreloadRecovery({ reload }).tryAutoReload();
  reload.mockClear();
  window.history.replaceState(null, "", "/rooms/12345?invite=instance#chat");
  const error = new Error("Unable to preload CSS for old.css");
  notify(error);
  const view = render(
    <StrictMode>
      <AppErrorPage error={error} />
    </StrictMode>,
  );
  expect(reload).not.toHaveBeenCalled();
  expect(view.textContent).toContain(preloadRecoveryMessage);
  press(view, "再読み込み");
  expect(reload.mock.results[0]?.value).toBe(
    "https://tetraboard.test/rooms/12345?invite=instance#chat",
  );
});

test("通常の例外には汎用案内を表示し、自動更新もエラー本文の表示もしない", () => {
  const view = render(<AppErrorPage error={new Error("secret detail")} />);
  expect(view.querySelector('[role="alert"]')?.textContent).toBe(unexpectedErrorMessage);
  expect(view.textContent).not.toContain("secret detail");
  expect(reload).not.toHaveBeenCalled();
  press(view, "再読み込み");
  expect(reload).toHaveBeenCalledTimes(1);
});

test("既存のルーム・棋譜のHTTPエラーは専用案内を保ち、自動更新しない", async () => {
  const cases = [
    { boundary: RoomErrorPage, status: 400, message: "ルームURLが不正です。" },
    { boundary: RoomErrorPage, status: 404, message: "ルームが見つかりません。" },
    { boundary: RoomErrorPage, status: 410, message: "このルームは閉鎖されています。" },
    { boundary: RoomErrorPage, status: 503, message: "本人確認ができませんでした。" },
    { boundary: MatchReplayErrorPage, status: 400, message: "棋譜のURLが正しくありません。" },
    { boundary: MatchReplayErrorPage, status: 404, message: "この棋譜は閲覧できません。" },
    { boundary: MatchReplayErrorPage, status: 503, message: "棋譜を取得できませんでした。" },
  ];
  for (const { boundary, status, message } of cases) {
    const router = createMemoryRouter([
      {
        path: "*",
        loader: () => {
          throw new Response(null, { status });
        },
        ErrorBoundary: boundary,
        hydrateFallbackElement: <p>読み込み中</p>,
      },
    ]);
    restores.push(() => router.dispose());
    const view = render(
      <AccountContext.Provider
        value={{
          user: null,
          loading: false,
          error: null,
          refresh: async () => {},
          update: () => {},
        }}
      >
        <RouterProvider router={router} />
      </AccountContext.Provider>,
    );
    await flush();
    expect(view.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(view.textContent).not.toContain(preloadRecoveryMessage);
  }
  expect(reload).not.toHaveBeenCalled();
});

for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const page of ["room", "replay"] as const) {
    test(`${game}の${page}のReact.lazy失敗は個別エラー境界から共通復旧へ進む`, async () => {
      const error = new Error("old chunk");
      const failingView = lazy<() => ReactElement>(async () => {
        notify(error);
        throw error;
      });
      if (page === "room") {
        replaceProperty(liveViews, game, failingView);
      } else {
        replaceProperty(replayViews, game, failingView);
      }
      const room = game === "four-reversi" ? waitingRoom() : waitingShogiRoom();
      const data =
        page === "room"
          ? {
              game,
              room,
              membership: null,
              presence: { hostPlayerId: null, connectedPlayerIds: [] },
              serverNowMs: 0,
              invited: false,
            }
          : {
              game,
              match: game === "four-reversi" ? replayMatch() : shogiReplayMatch().detail,
              frames: [],
            };
      const router = createMemoryRouter([
        {
          path: "*",
          loader: () => data,
          Component: page === "room" ? RoomPage : MatchReplayPage,
          ErrorBoundary: page === "room" ? RoomErrorPage : MatchReplayErrorPage,
          hydrateFallbackElement: <p>読み込み中</p>,
        },
      ]);
      restores.push(() => router.dispose());
      const view = render(<RouterProvider router={router} />);
      await flush();
      expect(view.textContent).toContain(preloadRecoveryMessage);
      expect(reload).toHaveBeenCalledTimes(1);
    });
  }
}

test("将棋棋譜loaderはpreloadエラーを503へ変換せず保持する", async () => {
  const error = new Error("old replay loader chunk");
  const loader = spyOn(replayLoaders, "four-shogi").mockImplementation(async () => {
    notify(error);
    throw error;
  });
  restores.push(() => loader.mockRestore());
  const id = shogiReplayMatch().detail.id;
  const pending = matchReplayLoader({
    params: { matchId: id },
    request: new Request(`https://tetraboard.test/account/matches/${id}`),
    context: new RouterContextProvider(),
    url: new URL(`https://tetraboard.test/account/matches/${id}`),
    pattern: "/account/matches/:matchId",
  });
  requests[0]!.respond({ match: shogiReplayMatch().detail });
  await expect(pending).rejects.toBe(error);
  expect(reload).not.toHaveBeenCalled();
});

test("初回ロビー失敗は紹介HTMLを保って一度更新し、再発時のリンクは現在URLを保持", async () => {
  window.history.replaceState(null, "", "/games/four-shogi?source=invite#intro");
  for (let attempt = 0; attempt < 2; attempt++) {
    const error = new Error("initial chunk missing");
    const router = createMemoryRouter(
      [
        {
          path: "/games/four-shogi",
          lazy: async () => {
            notify(error);
            throw error;
          },
          ErrorBoundary: AppRouteErrorPage,
        },
      ],
      { initialEntries: ["/games/four-shogi"] },
    );
    restores.push(() => router.dispose());
    const root = document.createElement("div");
    root.dataset.publicLobby = "four-shogi";
    root.innerHTML =
      '<h1>四人将棋</h1><p data-startup-status></p><a data-startup-reload href="/games/four-shogi">再読み込み</a>';
    const mount = mock();
    startPublicLobby(root, router, mount);
    await flush();
    expect(mount).not.toHaveBeenCalled();
    expect(root.querySelector("h1")?.textContent).toBe("四人将棋");
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(preloadRecoveryMessage);
    expect(reload).toHaveBeenCalledTimes(1);
    if (attempt === 1) {
      root.querySelector<HTMLAnchorElement>("a")!.click();
      expect(reload.mock.results.at(-1)?.value).toBe(
        "https://tetraboard.test/games/four-shogi?source=invite#intro",
      );
    }
  }
  expect(reload).toHaveBeenCalledTimes(2);
});
