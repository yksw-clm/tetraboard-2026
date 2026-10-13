import { expect, test } from "bun:test";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { LobbyRankings } from "../src/features/lobby/LobbyRankings";
import { act, clock, flush, press, render, requests, wrap } from "./harness";

const entry = { rank: 1, username: "ranker", name: "参加者", avatarUrl: null, value: 12 };
const rankings = {
  singles: {
    first: [entry],
    total: [{ ...entry, value: 40 }],
    knockouts: [{ ...entry, value: 25 }],
  },
  doubles: { wins: [entry], total: [{ ...entry, value: 30 }] },
};
function heading(view: HTMLElement) {
  return view.querySelector('[aria-label="ランキングのスライド"] [aria-hidden="false"] h3')!
    .textContent;
}

for (const game of gameIds) {
  test(`${game}: 10秒で項目を循環し、表示切替だけでは再取得しない`, async () => {
    const view = render(wrap()(<LobbyRankings game={game} />));
    clock.advance(0);
    requests
      .at(-1)!
      .respond(
        gameCatalog[game].hasModes
          ? rankings
          : { wins: rankings.singles.first, total: rankings.singles.total },
      );
    await flush();
    const first = gameCatalog[game].hasModes ? "優勝数" : "勝利数";
    expect(heading(view)).toBe(first);
    clock.advance(9999);
    expect(heading(view)).toBe(first);
    clock.advance(1);
    await flush();
    expect(heading(view)).toBe("対局数");
    clock.advance(10000);
    await flush();
    expect(heading(view)).toBe(game === "four-shogi" ? "撃破数" : first);
    const tabs = view.querySelector('[role="tablist"][aria-label="ランキングの集計項目"]')!;
    const selected = tabs.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(selected.textContent).toBe(heading(view));
    const panel = document.getElementById(selected.getAttribute("aria-controls")!);
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(selected.id);
    if (game === "four-shogi") {
      expect(view.querySelector('[aria-hidden="false"] ol')!.textContent).toContain("25人");
      clock.advance(10000);
      await flush();
      expect(heading(view)).toBe(first);
    }
    expect(requests).toHaveLength(1);
  });
}

test("自動切り替えのチェック・手動選択・非表示・フォーカス中の停止を扱う", async () => {
  const view = render(wrap()(<LobbyRankings game="four-shogi" />));
  clock.advance(0);
  requests[0]!.respond(rankings);
  await flush();
  const automatic = view.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(automatic.checked).toBe(true);
  expect(automatic.labels?.[0]?.textContent).toContain("自動切り替え");
  act(() => automatic.click());
  expect(automatic.checked).toBe(false);
  clock.advance(30000);
  await flush();
  expect(heading(view)).toBe("優勝数");
  act(() => view.querySelector<HTMLElement>('[role="tab"][id$="knockouts"]')!.click());
  await flush();
  expect(heading(view)).toBe("撃破数");
  act(() => automatic.click());
  expect(automatic.checked).toBe(true);
  clock.advance(10000);
  await flush();
  expect(heading(view)).toBe("優勝数");
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  try {
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    clock.advance(30000);
    await flush();
    expect(heading(view)).toBe("優勝数");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    clock.advance(10000);
    await flush();
    expect(heading(view)).toBe("対局数");
    const controls = view.querySelector('[aria-label="ランキングのスライド"]')!;
    const button = controls.querySelector<HTMLButtonElement>("button")!;
    act(() => button.focus());
    clock.advance(30000);
    await flush();
    expect(heading(view)).toBe("対局数");
    act(() => button.blur());
    clock.advance(10000);
    await flush();
    expect(heading(view)).toBe("撃破数");
  } finally {
    if (visibility) Object.defineProperty(document, "visibilityState", visibility);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("四人将棋の詳細へ撃破数を引き継ぎ、ダブルスでは撃破項目を出さない", async () => {
  const view = render(wrap()(<LobbyRankings game="four-shogi" />));
  clock.advance(0);
  requests[0]!.respond(rankings);
  await flush();
  act(() => view.querySelector<HTMLElement>('[role="tab"][id$="knockouts"]')!.click());
  await flush();
  press(view, "もっと見る");
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("h3")!.textContent).toBe("撃破数");
  clock.advance(30000);
  await flush();
  expect(heading(view)).toBe("撃破数");
  act(() => dialog.querySelector<HTMLElement>('[role="tab"][id$="doubles"]')!.click());
  await flush();
  expect(dialog.querySelector("h3")!.textContent).toBe("勝利数");
  expect(dialog.querySelector('[role="tab"][id$="knockouts"]')).toBeNull();
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  act(() => view.querySelector<HTMLElement>('[role="tab"][id$="doubles"]')!.click());
  await flush();
  expect(heading(view)).toBe("勝利数");
  clock.advance(10000);
  await flush();
  expect(heading(view)).toBe("対局数");
  clock.advance(10000);
  await flush();
  expect(heading(view)).toBe("勝利数");
  expect(
    view.querySelector('[role="tablist"][aria-label="ランキングの集計項目"]')!.textContent,
  ).not.toContain("撃破数");
});

test("旧応答の撃破数欠落は0件として表示せず、表示できない旨を案内する", async () => {
  const view = render(<LobbyRankings game="four-shogi" />);
  clock.advance(0);
  requests[0]!.respond({
    singles: { first: [], total: [] },
    doubles: { wins: [], total: [] },
  });
  await flush();
  act(() => view.querySelector<HTMLElement>('[role="tab"][id$="knockouts"]')!.click());
  await flush();
  expect(view.querySelector('[aria-hidden="false"]')!.textContent).toContain(
    "撃破数ランキングは現在表示できません。",
  );
});
