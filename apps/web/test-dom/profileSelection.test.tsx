import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { AccountPageShell, ProfilePage } from "../src/features/account/AccountPages";
import { AccountContext } from "../src/features/account/useAccount";
import { useAccountSelection } from "../src/features/account/useAccountSelection";
import { SavedMatchReplayView } from "../src/features/room/SavedMatchReplayView";
import { profile } from "../test/fixtures/account";
import { match } from "../test/fixtures/matchSummary";
import { shogiReplayMatch, shogiStats } from "../test/fixtures/fourShogiRecordFixtures";
import { act, clock, flush, press, render, renderHook, requests, wrap } from "./harness";

const stats = {
  singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
  doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
};
const shogi = shogiReplayMatch("doubles");

function profilePage(state?: unknown) {
  const router = createMemoryRouter(
    [
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
    { initialEntries: [{ pathname: "/account", state }] },
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

async function chooseGame(view: HTMLElement, name: string) {
  act(() => view.querySelector<HTMLButtonElement>('[aria-label^="ゲームを選択："]')!.click());
  await flush();
  const menu = document.querySelector('[aria-label="プロフィールのゲーム"]')!;
  expect(menu.querySelector('[aria-checked="true"]')).not.toBeNull();
  act(() =>
    [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.includes(name))!
      .click(),
  );
  await flush();
  expect(document.querySelector('[aria-label="プロフィールのゲーム"]')).toBeNull();
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

test("共通操作で戦績・棋譜を同期し、カード・キャッシュ・遅延応答とゲーム別モードを保持", async () => {
  const { view } = profilePage();
  expect(view.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  expect(view.querySelectorAll('[role="combobox"]')).toHaveLength(0);
  const profileCard = view.querySelector('[data-testid="account-profile-card"]');
  const historyCard = view.querySelector('[data-testid="account-replay-card"]');
  const lobby = view.querySelector<HTMLAnchorElement>('main a[href="/games/four-reversi"]')!;
  expect(lobby.className).toContain("bg-white");
  clock.advance(0);
  requests.find((r) => r.url === "/api/account/stats")!.respond(stats);
  requests
    .find((r) => r.url === "/api/account/matches?mode=singles")!
    .respond({
      matches: [match(1)],
      nextCursor: "next",
    });
  await flush();
  await chooseGame(view, "四人将棋");
  clock.advance(0);
  const shogiSingles = requests.find(
    (r) => r.url === "/api/account/matches?mode=singles&game=four-shogi",
  )!;
  chooseMode(view, "ダブルス");
  clock.advance(0);
  expect(view.querySelector('[data-testid="account-profile-card"]')).toBe(profileCard);
  expect(view.querySelector('[data-testid="account-replay-card"]')).toBe(historyCard);
  expect(view.querySelector('main a[href="/games/four-shogi"]')).not.toBeNull();
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
    .find((r) => r.url === "/api/account/matches?mode=doubles&game=four-shogi")!
    .respond({
      matches: [shogi.summary],
      nextCursor: null,
    });
  await flush();
  expect(historyCard!.textContent).toContain("四人将棋・ダブルス");
  const count = requests.length;
  await chooseGame(view, "四人リバーシ");
  clock.advance(0);
  expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
    "シングルス",
  );
  expect(historyCard!.textContent).toContain("四人リバーシ・シングルス");
  expect(view.textContent).toContain("もっと見る");
  expect(requests).toHaveLength(count);
  await chooseGame(view, "四人将棋");
  clock.advance(0);
  expect(view.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain(
    "ダブルス",
  );
  expect(historyCard!.textContent).toContain("四人将棋・ダブルス");
  expect(requests).toHaveLength(count);
  chooseMode(view, "シングルス");
  clock.advance(0);
  expect(view.textContent).toContain("撃破数");
  expect(historyCard!.textContent).toContain("まだ対局履歴がありません。");
  expect(requests).toHaveLength(count);
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
  act(() => view.querySelector<HTMLButtonElement>('[aria-label^="ゲームを選択："]')!.click());
  await flush();
  expect(
    document
      .querySelector('[aria-label="プロフィールのゲーム"]')!
      .closest(".game-theme-four-shogi"),
  ).not.toBeNull();
  act(() =>
    document.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')!.click(),
  );
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
  expect(view.querySelector('[aria-label="ゲームを選択：四人将棋"]')).not.toBeNull();
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
