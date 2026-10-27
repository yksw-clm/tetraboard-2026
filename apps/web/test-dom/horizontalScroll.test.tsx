import { expect, test } from "bun:test";
import { useRef } from "react";
import { AppHorizontalScrollButtons } from "../src/shared/ui/AppHorizontalScrollButtons";
import { RecentMatches } from "../src/features/matches/RecentMatches";
import { match } from "../test/fixtures/matchSummary";
import { act, clock, flush, press, render, rerender } from "./harness";
import { requests } from "./harness";
import { createMemoryRouter, RouterProvider } from "react-router";

test("横スクロールの境界と幅通知で矢印を切替え、動きを減らす場合は即時移動する", () => {
  const NativeObserver = globalThis.ResizeObserver;
  const nativeMatchMedia = window.matchMedia;
  let resized = () => {};
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resized = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {
      disconnected = true;
    }
  } as unknown as typeof ResizeObserver;
  try {
    function Scroller() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div>
          <div ref={ref} data-testid="scroller">
            <div>内容</div>
          </div>
          <AppHorizontalScrollButtons scrollRef={ref} label="一覧" />
        </div>
      );
    }
    const view = render(<Scroller />);
    const scroller = view.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    // 実際の画面寸法ではなく、スクロールAPIから渡される境界値を制御します。
    let width = 1200;
    Object.defineProperties(scroller, {
      clientWidth: { value: 400 },
      scrollWidth: { get: () => width },
    });
    let movement: ScrollToOptions | undefined;
    Object.defineProperty(scroller, "scrollBy", {
      value: (options: ScrollToOptions) => {
        movement = options;
      },
    });
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    clock.advance(16);
    const left = () => view.querySelector('[aria-label="一覧を左へスクロール"]');
    const right = () => view.querySelector('[aria-label="一覧を右へスクロール"]');
    expect(left()).toBeNull();
    expect(right()).not.toBeNull();
    act(() =>
      view.querySelector<HTMLButtonElement>('[aria-label="一覧を右へスクロール"]')!.click(),
    );
    expect(movement).toEqual({ left: 300, behavior: "smooth" });
    act(() => {
      scroller.scrollLeft = 300;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(left()).not.toBeNull();
    expect(right()).not.toBeNull();
    act(() => {
      scroller.scrollLeft = 800;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(right()).toBeNull();
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    act(() =>
      view.querySelector<HTMLButtonElement>('[aria-label="一覧を左へスクロール"]')!.click(),
    );
    expect(movement).toEqual({ left: -300, behavior: "instant" });
    act(() => {
      scroller.scrollLeft = 0;
      width = 400;
      resized();
    });
    expect(left()).toBeNull();
    expect(right()).toBeNull();
    rerender(view, null);
    expect(disconnected).toBe(true);
  } finally {
    globalThis.ResizeObserver = NativeObserver;
    window.matchMedia = nativeMatchMedia;
  }
});

test("最近の対局は総合ロビーだけゲームバッジを表示し、更新失敗でも棋譜を保持する", async () => {
  for (const game of ["all", "four-reversi"] as const) {
    const router = createMemoryRouter([{ path: "*", element: <RecentMatches game={game} /> }]);
    const view = render(<RouterProvider router={router} />);
    clock.advance(0);
    requests.at(-1)!.respond({ matches: [match(1)] });
    await flush();
    if (game !== "all") {
      press(view, "もっと見る");
      await flush();
    }
    const scope = game === "all" ? view : document.querySelector<HTMLElement>('[role="dialog"]')!;
    const card = scope.querySelector("article")!;
    expect(card).not.toBeNull();
    const gameBadge = [...card.querySelectorAll("span")].find(
      (element) => element.textContent === "四人リバーシ",
    );
    expect(Boolean(gameBadge)).toBe(game === "all");
    expect(card.getAttribute("aria-label")).toContain("四人リバーシ");
    press(scope, "更新");
    requests.at(-1)!.respond({}, 503);
    await flush();
    expect(scope.querySelector("article")).toBe(card);
    expect(scope.querySelector('[role="alert"]')).not.toBeNull();
    rerender(view, null);
    router.dispose();
  }
});
