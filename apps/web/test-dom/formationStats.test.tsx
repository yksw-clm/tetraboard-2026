import { expect, test } from "bun:test";
import { useState } from "react";
import { AccountStats } from "../src/features/account/AccountStats";
import { shogiStats } from "../test/fixtures/fourShogiRecordFixtures";
import { act, clock, flush, press, render, requests } from "./harness";

// 遅延エントリを準備し、DOM検証をモジュールの読込み時間から切り離す。
await import("../src/features/account/FormationStats");

const endpoint = "/api/account/four-shogi/formation-stats";
const stats = [{ id: "lower-gold", total: 3, first: 1, second: 1, third: 0, fourth: 1 }];
function fixture() {
  function View() {
    const [mode, setMode] = useState<"singles" | "doubles">("singles");
    const [game, setGame] = useState<"four-shogi" | "four-reversi">("four-shogi");
    return (
      <>
        <button onClick={() => setMode(mode === "singles" ? "doubles" : "singles")}>
          モード切替
        </button>
        <button onClick={() => setGame(game === "four-shogi" ? "four-reversi" : "four-shogi")}>
          ゲーム切替
        </button>
        <AccountStats game={game} mode={mode} />
      </>
    );
  }
  const view = render(<View />);
  clock.advance(0);
  return view;
}
function formationRequest() {
  return requests.filter((entry) => entry.url === endpoint).at(-1)!;
}

test("独立取得・全16枚・未経験の秘匿・経験済みの順位詳細とモード切替を確認", async () => {
  const view = fixture();
  expect(view.querySelector('[aria-label="戦法一覧"]')).toBeNull();
  requests.find((entry) => entry.url === "/api/account/stats?game=four-shogi")!.respond(shogiStats);
  await flush();
  expect(view.textContent).toContain("完全優勝数");
  expect(view.textContent).toContain("1.375");
  formationRequest().respond(stats);
  await flush();
  const cards = view
    .querySelector('[aria-label="戦法一覧"]')!
    .querySelectorAll<HTMLButtonElement>("button");
  expect(cards).toHaveLength(16);
  expect([...cards].filter((entry) => entry.disabled)).toHaveLength(15);
  expect(view.textContent).not.toContain("天守閣玉");
  expect(view.innerHTML).not.toContain("tenshukaku.jpg");
  expect(view.textContent).not.toContain("集計開始");
  expect(view.querySelectorAll('[aria-label="戦法一覧"] img')).toHaveLength(1);
  act(() => cards[0].click());
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  press(view, "地下鉄飛車・下段金寄せ");
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.closest(".game-theme-four-shogi")).not.toBeNull();
  expect(dialog.textContent).toContain("使用対局数");
  expect(dialog.textContent).toContain(".333");
  expect(dialog.textContent).not.toContain("撃破");
  expect(dialog.textContent).not.toContain("完全優勝");
  const count = requests.length;
  press(view, "モード切替");
  await flush();
  clock.advance(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(view.querySelector('[aria-label="戦法一覧"]')).toBeNull();
  expect(view.textContent).not.toContain("完全優勝数");
  press(view, "モード切替");
  await flush();
  clock.advance(0);
  expect(requests).toHaveLength(count);
  press(view, "地下鉄飛車・下段金寄せ");
  await flush();
  press(view, "ゲーム切替");
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("戦法別の初回失敗は未経験扱いせず、再試行・更新失敗で既存カードと詳細を保つ", async () => {
  const view = fixture();
  requests.find((entry) => entry.url === "/api/account/stats?game=four-shogi")!.respond(shogiStats);
  formationRequest().respond({}, 503);
  await flush();
  expect(view.querySelector('[aria-label="戦法一覧"]')).toBeNull();
  expect(view.textContent).toContain("戦法別戦績を取得できませんでした。");
  act(() => view.querySelector<HTMLButtonElement>('[aria-label="戦法別戦績を再試行"]')!.click());
  formationRequest().respond(stats);
  await flush();
  press(view, "更新");
  expect(requests.filter((entry) => entry.url.includes("/account/stats"))).toHaveLength(2);
  expect(view.querySelector('[aria-label="戦法一覧"]')).not.toBeNull();
  formationRequest().respond({}, 503);
  requests
    .filter((entry) => entry.url.includes("/account/stats"))
    .at(-1)!
    .respond({}, 503);
  await flush();
  expect(view.querySelector('[aria-label="戦法一覧"]')).not.toBeNull();
  press(view, "地下鉄飛車・下段金寄せ");
  await flush();
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("使用対局数");
});

test("正常な0件は全カード未経験、戦績失敗とは独立し不明IDを成功扱いしない", async () => {
  const view = fixture();
  requests.find((entry) => entry.url === "/api/account/stats?game=four-shogi")!.respond({}, 503);
  formationRequest().respond([]);
  await flush();
  expect(view.querySelectorAll('[aria-label="戦法一覧"] button:disabled')).toHaveLength(16);
  expect(view.querySelectorAll('[aria-label="戦法一覧"] img')).toHaveLength(0);
  press(view, "更新");
  formationRequest().respond([{ ...stats[0], id: "unknown" }]);
  requests
    .filter((entry) => entry.url.includes("/account/stats"))
    .at(-1)!
    .respond(shogiStats);
  await flush();
  expect(view.textContent).toContain("戦法別戦績を取得できませんでした。");
  expect(view.textContent).toContain("完全優勝数");
});
