import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { LobbyView } from "../src/features/lobby/LobbyView";
import { AccountPageShell, ProfilePage } from "../src/features/account/AccountPages";
import { AccountContext } from "../src/features/account/useAccount";
import { useAccountSelection } from "../src/features/account/useAccountSelection";
import { SavedMatchReplayView } from "../src/features/room/SavedMatchReplayView";
import { profile } from "../test/fixtures/account";
import { match } from "../test/fixtures/matchSummary";
import { shogiReplayMatch, shogiStats } from "../test/fixtures/fourShogiRecordFixtures";
import { act, clock, flush, press, render, renderHook, rerender, requests, wrap } from "./harness";

const stats = {
  singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
  doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
};
const shogi = shogiReplayMatch("doubles");

function profilePage(state?: unknown, lobbyGame?: GameId) {
  const router = createMemoryRouter(
    [
      ...(lobbyGame
        ? [
            {
              path: gameCatalog[lobbyGame].lobbyPath,
              element: (
                <LobbyView
                  game={lobbyGame}
                  name=""
                  roomCode=""
                  mode="doubles"
                  cpuLevel={1}
                  timeControl={{ mainTimeMs: 300000, byoyomiMs: 30000 }}
                  isSubmitting={null}
                  message={null}
                  renderRooms={() => null}
                  onNameChange={() => {}}
                  onRoomCodeChange={() => {}}
                  onModeChange={() => {}}
                  onCpuLevelChange={() => {}}
                  onTimeControlChange={() => {}}
                  onClearMessage={() => {}}
                />
              ),
            },
          ]
        : []),
      { path: "/account", element: <ProfilePage /> },
      {
        path: "/account/matches/:matchId",
        element: (
          <SavedMatchReplayView
            match={shogi.detail}
            theme="four-shogi"
            board={<p>保存済み盤面</p>}
            replay={{ frames: [{ label: "開始局面" }], index: 0, select() {} }}
            result={<p>結果</p>}
            onRotate={() => {}}
          />
        ),
      },
    ],
    {
      initialEntries: [
        { pathname: lobbyGame ? gameCatalog[lobbyGame].lobbyPath : "/account", state },
      ],
    },
  );
  const view = render(
    <AccountContext.Provider
      value={{ user: profile, loading: false, error: null, refresh: async () => {}, update() {} }}
    >
      <RouterProvider router={router} />
    </AccountContext.Provider>,
  );
  return { view, router };
}

async function openMyPage(view: HTMLElement) {
  act(() => view.querySelector<HTMLButtonElement>('[aria-label$="のアカウントメニュー"]')!.click());
  await flush();
  act(() =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.includes("マイページ"))!
      .click(),
  );
  await flush();
}

async function chooseGame(view: HTMLElement, name: string) {
  const buttons = view.querySelectorAll<HTMLButtonElement>(
    '[aria-label="プロフィールのゲーム"] button',
  );
  act(() => [...buttons].find((button) => button.textContent === name)!.click());
  await flush();
  expect(selectedGameName(view)).toBe(name);
}

function selectedGameName(view: HTMLElement) {
  return view.querySelector('[aria-label="プロフィールのゲーム"] button[aria-pressed="true"]')
    ?.textContent;
}

function chooseMode(view: HTMLElement, name: string) {
  act(() =>
    [...view.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes(name))!
      .click(),
  );
  const selected = view.querySelector('[role="tab"][aria-selected="true"]')!;
  const panel = view.querySelector('[role="tabpanel"]')!;
  expect(selected.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-labelledby")).toBe(selected.id);
}

test("全6ロビーのマイページは移動元の戦績・棋譜を最初に取得し、0件でも選択と復元を維持", async () => {
  for (const game of gameIds) {
    const { view, router } = profilePage(
      {
        accountSelection: {
          game: "four-reversi",
          modes: { "four-reversi": "doubles", "four-shogi": "doubles" },
        },
      },
      game,
    );
    const requestStart = requests.length;
    await openMyPage(view);
    expect(router.state.location.pathname).toBe("/account");
    expect(router.state.location.search).toBe("");
    expect(selectedGameName(view)).toBe(gameCatalog[game].name);
    expect(view.querySelector("main")!.textContent).not.toContain("ロビーへ");
    const background = view.querySelector("main")!.closest(".lobby-background")!;
    if (game !== "four-reversi")
      expect(
        background.classList.contains(`game-theme-${game === "four-gomoku" ? "gomoku" : game}`),
      ).toBe(true);
    if (gameCatalog[game].hasModes) {
      expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
        "シングルス",
      );
    } else {
      expect(view.querySelector('[role="tablist"]')!.hasAttribute("hidden")).toBe(true);
    }
    expect(view.textContent).toContain("戦績を読み込んでいます");
    expect(view.textContent).not.toContain("まだ対局履歴がありません。");
    clock.advance(0);
    const accountRequests = requests.slice(requestStart);
    const statsRequest = accountRequests.find((r) => r.url.startsWith("/api/account/stats"))!;
    const historyRequest = accountRequests.find((r) => r.url.startsWith("/api/account/matches"))!;
    for (const request of [statsRequest, historyRequest]) {
      expect(new URL(request.url, "https://example.test").searchParams.get("game")).toBe(
        game === "four-reversi" ? null : game,
      );
    }
    expect(new URL(historyRequest.url, "https://example.test").searchParams.get("mode")).toBe(
      gameCatalog[game].hasModes ? "singles" : null,
    );
    expect(accountRequests.filter((r) => r.url.startsWith("/api/account/stats"))).toHaveLength(1);
    expect(accountRequests.filter((r) => r.url.startsWith("/api/account/matches"))).toHaveLength(1);
    const singles = { total: 0, first: 0, second: 0, third: 0, fourth: 0 };
    statsRequest.respond(
      gameCatalog[game].hasModes
        ? {
            singles: game === "four-shogi" ? { ...singles, knockouts: 0, perfectWins: 0 } : singles,
            doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
          }
        : { total: 0, wins: 0, losses: 0, draws: 0 },
    );
    historyRequest.respond({ matches: [], nextCursor: null });
    accountRequests.find((r) => r.url.endsWith("/formation-stats"))?.respond([]);
    await flush();
    expect(view.textContent).toContain("まだ対局履歴がありません。");
    expect(
      view.querySelector('table[aria-label="戦績"] td > span > span:last-child')!.textContent,
    ).toBe("0");
    expect(selectedGameName(view)).toBe(gameCatalog[game].name);
    const nextGame = gameCatalog[game].hasModes ? game : "four-shogi";
    await chooseGame(view, gameCatalog[nextGame].name);
    chooseMode(view, "ダブルス");
    const selection = router.state.location.state.accountSelection;
    const restored = renderHook(
      useAccountSelection,
      undefined,
      wrap(null, { pathname: "/account", state: router.state.location.state }),
    );
    expect(restored.current.game).toBe(nextGame);
    expect(restored.current.mode).toBe("doubles");
    restored.unmount();
    await act(() => router.navigate(-1));
    await flush();
    expect(router.state.location.pathname).toBe(gameCatalog[game].lobbyPath);
    await act(() => router.navigate(1));
    await flush();
    expect(router.state.location.state.accountSelection).toEqual(selection);
    expect(selectedGameName(view)).toBe(gameCatalog[nextGame].name);
    expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
      "ダブルス",
    );
    rerender(view, null);
  }
});

test("共通操作で戦績・棋譜を同期し、カード・キャッシュ・遅延応答とゲーム別モードを保持", async () => {
  const { view } = profilePage();
  expect(
    view.querySelectorAll('[role="tablist"][aria-label="プロフィールの対局モード"]'),
  ).toHaveLength(1);
  expect(view.querySelectorAll('[role="tablist"][aria-label="棋譜の絞り込み"]')).toHaveLength(1);
  expect(view.querySelectorAll('[role="combobox"]')).toHaveLength(0);
  const profileCard = view.querySelector('[data-testid="account-profile-card"]');
  const historyCard = view.querySelector('[data-testid="account-replay-card"]');
  const gameButtons = view.querySelector('[role="group"][aria-label="プロフィールのゲーム"]')!;
  const modeTabs = view.querySelector('[role="tablist"]')!;
  expect(profileCard!.nextElementSibling).toBe(gameButtons);
  expect(gameButtons.compareDocumentPosition(modeTabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const buttons = [...gameButtons.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(
    gameIds.map((game) => gameCatalog[game].name),
  );
  expect(buttons.every((button) => button.querySelector('img[alt=""][src]'))).toBe(true);
  expect(gameButtons.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
  expect(selectedGameName(view)).toBe("四人リバーシ");
  clock.advance(0);
  requests.find((r) => r.url === "/api/account/stats")!.respond(stats);
  requests
    .find(
      (r) => r.url === "/api/account/matches?mode=singles&includeMoveCount=1&includeMatchKind=1",
    )!
    .respond({
      matches: [match(1)],
      nextCursor: "next",
    });
  await flush();
  await chooseGame(view, "四人将棋");
  clock.advance(0);
  const shogiSingles = requests.find(
    (r) =>
      r.url ===
      "/api/account/matches?mode=singles&includeMoveCount=1&includeMatchKind=1&game=four-shogi",
  )!;
  chooseMode(view, "ダブルス");
  clock.advance(0);
  expect(view.querySelector('[data-testid="account-profile-card"]')).toBe(profileCard);
  expect(view.querySelector('[data-testid="account-replay-card"]')).toBe(historyCard);
  expect(view.querySelector("header")!.closest(".game-theme-four-shogi")).toBeNull();
  expect(
    view
      .querySelector("main")!
      .closest(".lobby-background")!
      .classList.contains("game-theme-four-shogi"),
  ).toBe(true);
  requests.find((r) => r.url === "/api/account/stats?game=four-shogi")!.respond(shogiStats);
  shogiSingles.respond({ matches: [], nextCursor: null });
  await flush();
  expect(view.textContent).not.toContain("撃破数");
  expect(view.textContent).not.toContain("まだ対局履歴がありません。");
  requests
    .find(
      (r) =>
        r.url ===
        "/api/account/matches?mode=doubles&includeMoveCount=1&includeMatchKind=1&game=four-shogi",
    )!
    .respond({
      matches: [shogi.summary],
      nextCursor: null,
    });
  await flush();
  expect(historyCard!.textContent).toContain("四人将棋");
  expect(historyCard!.textContent).toContain("ダブルス");
  const historyRequests = () =>
    requests.filter(
      ({ url }) => url.startsWith("/api/account/stats") || url.startsWith("/api/account/matches"),
    );
  const count = historyRequests().length;
  await chooseGame(view, "四人リバーシ");
  clock.advance(0);
  expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
    "シングルス",
  );
  expect(historyCard!.textContent).toContain("四人リバーシ");
  expect(historyCard!.textContent).toContain("シングルス");
  expect(view.textContent).toContain("もっと見る");
  expect(historyRequests()).toHaveLength(count);
  await chooseGame(view, "四人将棋");
  clock.advance(0);
  expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
    "ダブルス",
  );
  expect(historyCard!.textContent).toContain("四人将棋");
  expect(historyCard!.textContent).toContain("ダブルス");
  expect(historyRequests()).toHaveLength(count);
  chooseMode(view, "シングルス");
  clock.advance(0);
  expect(view.textContent).toContain("撃破数");
  expect(historyCard!.textContent).toContain("まだ対局履歴がありません。");
  expect(historyRequests()).toHaveLength(count);
  await flush();
});

test("棋譜往復と再表示で共通選択・無関係な履歴stateを復元し、Portalにもテーマを適用", async () => {
  const state = {
    other: "保持",
    accountSelection: {
      game: "four-shogi",
      modes: { "four-reversi": "singles", "four-shogi": "doubles" },
    },
  };
  const { view, router } = profilePage(state);
  clock.advance(0);
  requests.find((r) => r.url.includes("/stats"))!.respond(shogiStats);
  requests
    .find((r) => r.url.includes("/matches"))!
    .respond({ matches: [shogi.summary], nextCursor: null });
  await flush();
  press(view, "プロフィールを編集");
  await flush();
  expect(
    document.querySelector('[role="dialog"]')!.closest(".game-theme-four-shogi"),
  ).not.toBeNull();
  act(() =>
    document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="閉じる"]')!.click(),
  );
  clock.advance(1000);
  await flush();
  act(() => view.querySelector<HTMLAnchorElement>('a[href^="/account/matches/"]')!.click());
  await flush();
  expect(router.state.location.state).toEqual(state);
  act(() => view.querySelector<HTMLAnchorElement>('a[href="/account"]')!.click());
  await flush();
  expect(selectedGameName(view)).toBe("四人将棋");
  expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
    "ダブルス",
  );
  chooseMode(view, "シングルス");
  expect(router.state.location.state.other).toBe("保持");
  const restored = renderHook(
    useAccountSelection,
    undefined,
    wrap(null, { pathname: "/account", state: router.state.location.state }),
  );
  expect(restored.current.game).toBe("four-shogi");
  expect(restored.current.mode).toBe("singles");
  await flush();
});

test("旧履歴は棋譜側・戦績側・初期値の順に有効な選択を復元", () => {
  for (const [state, game, mode] of [
    [
      {
        accountSelections: {
          history: { game: "four-shogi", modes: { "four-shogi": "singles" } },
          stats: { game: "four-reversi", modes: { "four-shogi": "doubles" } },
        },
      },
      "four-shogi",
      "singles",
    ],
    [
      {
        accountSelections: {
          history: { game: "unknown", modes: { "four-shogi": "invalid" } },
          stats: { game: "four-shogi", modes: { "four-shogi": "doubles" } },
        },
      },
      "four-shogi",
      "doubles",
    ],
    [{ accountSelections: { history: { game: "unknown" } } }, "four-reversi", "singles"],
    [
      {
        accountSelection: { game: "four-reversi", modes: { "four-reversi": "doubles" } },
        accountSelections: { history: { game: "four-shogi" } },
      },
      "four-reversi",
      "doubles",
    ],
  ] as const) {
    const h = renderHook(
      () => ({ selection: useAccountSelection(), location: useLocation() }),
      undefined,
      wrap(null, { pathname: "/account", state: { ...state, other: "保持" } }),
    );
    expect(h.current.selection.game).toBe(game);
    expect(h.current.selection.mode).toBe(mode);
    act(() => h.current.selection.setMode("doubles"));
    expect(h.current.location.state.other).toBe("保持");
    expect(h.current.location.state.accountSelection.game).toBe(game);
    h.unmount();
  }
});

test("フォーム用の画面は既定背景と下部のロビーリンクを維持", () => {
  const view = render(
    wrap()(
      <AccountPageShell>
        <p>フォーム</p>
      </AccountPageShell>,
    ),
  );
  expect(view.querySelector(".game-theme-four-shogi")).toBeNull();
  expect(view.querySelector("main")!.lastElementChild!.textContent).toBe("ロビーへ");
  expect(view.querySelector(".app-theme.lobby-background")).not.toBeNull();
});

test("四人五目並べのダブルス戦績と履歴を表示し、ゲーム往復と再表示で選択を復元する", async () => {
  const { view, router } = profilePage({
    accountSelection: { game: "four-gomoku", modes: { "four-gomoku": "singles" } },
  });
  clock.advance(0);
  requests.find((r) => r.url === "/api/account/stats?game=four-gomoku")!.respond(stats);
  requests
    .find(
      (r) =>
        r.url ===
        "/api/account/matches?mode=singles&includeMoveCount=1&includeMatchKind=1&game=four-gomoku",
    )!
    .respond({ matches: [], nextCursor: null });
  await flush();
  chooseMode(view, "ダブルス");
  clock.advance(0);
  const summary = {
    ...match(1, "doubles"),
    game: "four-gomoku",
    result: { mode: "doubles", reason: "five", winner: "black-red" },
  };
  requests
    .find(
      (r) =>
        r.url ===
        "/api/account/matches?mode=doubles&includeMoveCount=1&includeMatchKind=1&game=four-gomoku",
    )!
    .respond({ matches: [summary], nextCursor: null });
  await flush();
  expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
    "ダブルス",
  );
  expect(view.querySelector('table[aria-label="戦績"]')!.textContent).toContain("勝数");
  expect(view.querySelector('table[aria-label="戦績"]')!.textContent).not.toContain("優勝数");
  expect(view.querySelector('[data-testid="account-replay-card"]')!.textContent).toContain(
    "ダブルス",
  );
  expect(view.querySelector(`a[href="/account/matches/${summary.id}"]`)).not.toBeNull();
  await chooseGame(view, "四人将棋");
  await chooseGame(view, "四人五目並べ");
  expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
    "ダブルス",
  );
  const restored = renderHook(
    useAccountSelection,
    undefined,
    wrap(null, { pathname: "/account", state: router.state.location.state }),
  );
  expect(restored.current.game).toBe("four-gomoku");
  expect(restored.current.mode).toBe("doubles");
});
