import { expect, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import { RecentMatches } from "../src/features/matches/RecentMatches";
import { match } from "../test/fixtures/matchSummary";
import { shogiReplayMatch } from "../test/fixtures/fourShogiRecordFixtures";
import { act, clock, flush, press, render, requests } from "./harness";

async function closeDialog() {
  act(() =>
    document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="閉じる"]')!.click(),
  );
  clock.advance(1000);
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}

test("もっと見るは20件をダイアログで表示し、ロビーの3件を保って公開棋譜へ移動する", async () => {
  const router = createMemoryRouter([
    { path: "/", element: <RecentMatches game="four-reversi" /> },
    { path: "/matches/:id", element: <p>公開棋譜</p> },
  ]);
  const view = render(<RouterProvider router={router} />);
  try {
    clock.advance(0);
    const matches = Array.from({ length: 20 }, (_, index) => match(index + 1));
    requests.at(-1)!.respond({ matches });
    await flush();
    const preview = view.querySelector('ul[aria-label="最近行われた対局の棋譜"]')!;
    expect(preview.children).toHaveLength(3);
    expect(view.querySelector("article")).toBeNull();
    expect(view.querySelector('input[type="checkbox"]')).toBeNull();
    const requestCount = requests.length;
    press(view, "もっと見る");
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector("h2")!.textContent).toBe("最近の対局");
    expect(dialog.querySelectorAll("article")).toHaveLength(20);
    expect(preview.children).toHaveLength(3);
    expect(view.querySelector("article")).toBeNull();
    expect(view.textContent).not.toContain("折りたたむ");
    expect(requests).toHaveLength(requestCount);
    const replayPath = `/matches/${matches[19]!.id}`;
    act(() => dialog.querySelector<HTMLAnchorElement>(`a[href="${replayPath}"]`)!.click());
    await flush();
    expect(router.state.location.pathname).toBe(replayPath);
    expect(view.textContent).toBe("公開棋譜");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    router.dispose();
  }
});

test("ゲームテーマの詳細内で対人戦に絞り、更新失敗はカードを保持し再表示でも条件を保つ", async () => {
  const router = createMemoryRouter([{ path: "*", element: <RecentMatches game="four-shogi" /> }]);
  const view = render(<RouterProvider router={router} />);
  try {
    const summary = shogiReplayMatch("doubles").summary;
    clock.advance(0);
    requests.at(-1)!.respond({ matches: [summary] });
    await flush();
    press(view, "もっと見る");
    await flush();
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.closest(".game-theme-four-shogi")).not.toBeNull();
    act(() => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    clock.advance(0);
    expect(requests.at(-1)!.url).toContain("game=four-shogi");
    expect(requests.at(-1)!.url).toContain("humanOnly=true");
    const humanMatch = {
      ...summary,
      participants: summary.participants.map((player) => ({
        id: player.id,
        name: player.name,
        side: player.side,
        seat: player.seat,
        kind: "human" as const,
        avatarUrl: null,
      })),
    };
    requests.at(-1)!.respond({ matches: [humanMatch] });
    await flush();
    const card = dialog.querySelector("article")!;
    expect(card).not.toBeNull();
    press(dialog, "更新");
    requests.at(-1)!.respond({}, 503);
    await flush();
    expect(dialog.querySelector("article")).toBe(card);
    expect(dialog.querySelector('[role="alert"]')!.textContent).toContain("取得できませんでした");
    await closeDialog();
    expect(view.querySelectorAll('ul[aria-label="最近行われた対局の棋譜"] > li')).toHaveLength(1);
    press(view, "もっと見る");
    await flush();
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(dialog.querySelector("article")).not.toBeNull();
    press(dialog, "再試行");
    expect(requests.at(-1)!.url).toContain("humanOnly=true");
    requests.at(-1)!.respond({ matches: [] });
    await flush();
    expect(dialog.textContent).toContain("対人戦の対局履歴がありません。");
    expect(dialog.querySelector("article")).toBeNull();
  } finally {
    router.dispose();
  }
});

test("初回失敗は詳細から再試行でき、取得中に閉じてもプレビューへ結果を反映する", async () => {
  const router = createMemoryRouter([
    { path: "*", element: <RecentMatches game="four-reversi" /> },
  ]);
  const view = render(<RouterProvider router={router} />);
  try {
    clock.advance(0);
    press(view, "もっと見る");
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain("読み込んでいます");
    requests.at(-1)!.respond({}, 503);
    await flush();
    expect(dialog.querySelector('[role="alert"]')).not.toBeNull();
    press(dialog, "再試行");
    await closeDialog();
    requests.at(-1)!.respond({ matches: [match(1)] });
    await flush();
    expect(view.querySelectorAll('ul[aria-label="最近行われた対局の棋譜"] > li')).toHaveLength(1);
    expect(view.querySelector('[role="alert"]')).toBeNull();
    const requestCount = requests.length;
    press(view, "もっと見る");
    await flush();
    expect(document.querySelectorAll('[role="dialog"] article')).toHaveLength(1);
    expect(requests).toHaveLength(requestCount);
  } finally {
    router.dispose();
  }
});
