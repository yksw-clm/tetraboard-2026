import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { AccountProfile, MatchHistoryFilter } from "@tetraboard/protocol";
import { MatchHistory } from "../src/features/account/MatchHistory";
import { useMatchHistory } from "../src/features/account/useMatchHistory";
import { useMatchHistoryFilter } from "../src/features/account/useMatchHistoryFilter";
import { useAccountSelection } from "../src/features/account/useAccountSelection";
import { AccountContext } from "../src/features/account/useAccount";
import { profile } from "../test/fixtures/account";
import { match } from "../test/fixtures/matchSummary";
import { act, clock, flush, press, render, renderHook, rerender, requests, wrap } from "./harness";

const useFilteredHistory = (filter: MatchHistoryFilter) =>
  useMatchHistory("four-reversi", "singles", filter);
test("フィルター別に一覧と追加位置を保持し、遅延応答と更新を別条件に混ぜない", async () => {
  const h = renderHook(useFilteredHistory, "all" as MatchHistoryFilter, wrap());
  clock.advance(0);
  requests[0]!.respond({ matches: [match(1)], nextCursor: "all-next" });
  await flush();
  h.rerender("rated");
  clock.advance(0);
  const rated = requests[1]!;
  expect(rated.url).toContain("filter=rated");
  expect(rated.url).not.toContain("cursor=");
  h.rerender("cpu");
  clock.advance(0);
  rated.respond({
    matches: [{ ...match(2), matchKind: "rated" }],
    nextCursor: "rated-next",
    filter: "rated",
  });
  await flush();
  expect(h.current.page.matches).toEqual([]);
  requests[2]!.respond({ matches: [match(3)], nextCursor: "cpu-next", filter: "cpu" });
  await flush();
  act(() => {
    void h.current.loadMore();
    void h.current.loadMore();
  });
  expect(requests).toHaveLength(4);
  expect(requests[3]!.url).toContain("filter=cpu&cursor=cpu-next");
  requests[3]!.respond({}, 503);
  await flush();
  expect(h.current.page.matches.map((m) => m.id)).toEqual([match(3).id]);
  act(() => {
    void h.current.retry();
  });
  expect(requests[4]!.url).toBe(requests[3]!.url);
  requests[4]!.respond({ matches: [match(4)], nextCursor: null, filter: "cpu" });
  await flush();
  h.rerender("rated");
  expect(h.current.page.matches.map((m) => m.id)).toEqual([match(2).id]);
  expect(h.current.page.nextCursor).toBe("rated-next");
  act(() => {
    void h.current.refresh();
  });
  expect(requests[5]!.url).toContain("filter=rated");
  expect(requests[5]!.url).not.toContain("cursor=");
  requests[5]!.respond({ matches: [], nextCursor: null, filter: "rated" });
  await flush();
  h.rerender("all");
  expect(h.current.page.matches.map((m) => m.id)).toEqual([match(1).id]);
});

test("旧Workerが絞り込みを無視した応答は成功扱いせず、同じ条件で再試行する", async () => {
  const h = renderHook(useFilteredHistory, "human" as MatchHistoryFilter, wrap());
  clock.advance(0);
  requests[0]!.respond({ matches: [match(1)], nextCursor: null });
  await flush();
  expect(h.current.page.error).not.toBeNull();
  expect(h.current.page.matches).toEqual([]);
  expect(requests).toHaveLength(1);
  act(() => {
    void h.current.retry();
  });
  expect(requests[1]!.url).toBe(requests[0]!.url);
});

function chooseFilter(view: HTMLElement, name: string) {
  const tab = [...view.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (tab) => tab.textContent?.trim() === name,
  )!;
  act(() => tab.click());
  expect(tab.getAttribute("aria-selected")).toBe("true");
  const panel = view.querySelector('[role="tabpanel"]')!;
  expect(tab.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
}

test("共通タブの4択と対応パネルを表示し、読み込み・空一覧・失敗・レート非対応を区別する", async () => {
  const view = render(wrap(profile, "/account")(<MatchHistory game="gomoku" mode="singles" />));
  expect(
    view.querySelectorAll('[role="tablist"][aria-label="棋譜の絞り込み"] [role="tab"]'),
  ).toHaveLength(4);
  expect(view.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("すべて");
  expect(view.textContent).toContain("レート戦にはCPU補充局を含みます。");
  clock.advance(0);
  requests[0]!.respond({ matches: [], nextCursor: null });
  await flush();
  expect(view.textContent).toContain("まだ対局履歴がありません。");
  chooseFilter(view, "レート戦");
  clock.advance(0);
  expect(view.textContent).toContain("対局履歴を読み込んでいます");
  expect(view.textContent).not.toContain("まだ対局履歴がありません。");
  requests[1]!.respond({ matches: [], nextCursor: null, filter: "rated" });
  await flush();
  expect(view.textContent).toContain("このゲーム・モードにはレート戦がありません。");
  chooseFilter(view, "CPU戦");
  clock.advance(0);
  requests[2]!.respond({}, 503);
  await flush();
  expect(view.textContent).toContain("対局履歴を取得できませんでした。");
  expect(view.textContent).not.toContain("この条件に一致する棋譜はありません。");
  press(view, "再試行");
  requests[3]!.respond({ matches: [], nextCursor: null, filter: "cpu" });
  await flush();
  expect(view.textContent).toContain("この条件に一致する棋譜はありません。");
  expect(requests.every((r) => !r.url.includes("/stats"))).toBe(true);
});

test("ゲーム・モード切替と棋譜往復・再表示で選択を復元し、別アカウントへ引き継がない", async () => {
  let selected: ReturnType<typeof useMatchHistoryFilter> & ReturnType<typeof useAccountSelection>;
  function Probe() {
    selected = { ...useMatchHistoryFilter(), ...useAccountSelection() };
    return <output>{useLocation().pathname}</output>;
  }
  const routes = [
    { path: "/account", element: <Probe /> },
    { path: "/account/matches/:id", element: <p>棋譜</p> },
  ];
  const router = createMemoryRouter(routes, {
    initialEntries: [{ pathname: "/account", state: { keep: "保持" } }],
  });
  const tree = (user: AccountProfile) => (
    <AccountContext.Provider
      value={{ user, loading: false, error: null, refresh: async () => {}, update() {} }}
    >
      <RouterProvider router={router} />
    </AccountContext.Provider>
  );
  const view = render(tree(profile));
  act(() => selected!.setFilter("cpu"));
  await flush();
  act(() => selected!.setGame("four-shogi"));
  await flush();
  act(() => selected!.setMode("doubles"));
  await flush();
  expect(selected!.filter).toBe("cpu");
  expect(router.state.location.state.keep).toBe("保持");
  await act(async () => {
    await router.navigate("/account/matches/fixture");
  });
  await act(async () => {
    await router.navigate(-1);
  });
  expect(selected!.filter).toBe("cpu");
  const restored = renderHook(
    useMatchHistoryFilter,
    undefined,
    wrap(profile, { pathname: "/account", state: router.state.location.state }),
  );
  expect(restored.current.filter).toBe("cpu");
  rerender(view, tree({ ...profile, username: "another_user" }));
  await flush();
  expect(selected!.filter).toBe("all");
  rerender(view, tree(profile));
  await flush();
  expect(selected!.filter).toBe("all");
});
