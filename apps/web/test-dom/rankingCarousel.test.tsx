import { expect, test } from "bun:test";
import { isRatedMatchmakingGame } from "@tetraboard/protocol";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
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
const ratingEntry = { ...entry, profileId: "11111111-1111-4111-8111-111111111111", value: 1680 };
const normalRequest = () => requests.filter(({ url }) => url.includes("/rankings?")).at(-1)!;
const ratingRequest = () => requests.filter(({ url }) => url.endsWith("/rankings/rating")).at(-1)!;
const selected = (view: HTMLElement) =>
  view.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
function tab(view: Element, name: string) {
  const target = [...view.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (item) => item.textContent === name,
  )!;
  act(() => target.click());
}
async function settleSwitch() {
  clock.advance(100);
  await flush();
  clock.advance(150);
  await flush();
}
async function ready(game: "four-shogi" | "shogi" = "four-shogi") {
  const view = render(
    wrap()(
      <PlayerProfileProvider>
        <LobbyRankings game={game} />
      </PlayerProfileProvider>,
    ),
  );
  clock.advance(0);
  normalRequest().respond(
    game === "shogi" ? { wins: rankings.singles.first, total: rankings.singles.total } : rankings,
  );
  ratingRequest().respond({ entries: [ratingEntry] });
  await flush();
  return view;
}
for (const game of gameIds) {
  test(`${game}: 対応ゲームだけ10秒後にレートへ切り替え、追加通信しない`, async () => {
    const view = render(wrap()(<LobbyRankings game={game} />));
    clock.advance(0);
    normalRequest().respond(
      gameCatalog[game].hasModes
        ? rankings
        : { wins: rankings.singles.first, total: rankings.singles.total },
    );
    const rated = isRatedMatchmakingGame(game);
    if (rated) ratingRequest().respond({ entries: [ratingEntry] });
    await flush();
    expect(view.querySelectorAll("li")).toHaveLength(1);
    clock.advance(9999);
    expect(view.textContent).toContain("12回");
    clock.advance(1);
    await settleSwitch();
    if (rated) {
      expect(selected(view)).toBe("レート");
      expect(view.textContent).toContain("1680");
      expect(view.textContent).not.toContain("1680回");
      clock.advance(10_000);
      await settleSwitch();
      expect(view.textContent).toContain("12回");
    } else expect(Boolean(view.querySelector('[role="tablist"]'))).toBe(false);
    expect(requests).toHaveLength(rated ? 2 : 1);
  });
}

test("手動操作は最後の選択を優先し、停止は再開まで維持する", async () => {
  const view = await ready();
  tab(view, "レート");
  tab(view, "優勝数");
  await settleSwitch();
  expect(selected(view)).toBe("優勝数");
  tab(view, "レート");
  await settleSwitch();
  act(() =>
    view.querySelector<HTMLButtonElement>('[aria-label="ランキングの自動切替を停止"]')!.click(),
  );
  clock.advance(30_000);
  expect(selected(view)).toBe("レート");
  tab(view, "優勝数");
  await settleSwitch();
  clock.advance(30_000);
  expect(selected(view)).toBe("優勝数");
  act(() =>
    view.querySelector<HTMLButtonElement>('[aria-label="ランキングの自動切替を再開"]')!.click(),
  );
  clock.advance(10_000);
  await settleSwitch();
  expect(selected(view)).toBe("レート");
});

test("マウスとフォーカスで停止し、解除後に10秒数え直す。タッチは停止しない", async () => {
  const view = await ready();
  const section = view.querySelector("section")!;
  act(() =>
    section.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })),
  );
  clock.advance(30_000);
  expect(selected(view)).toBe("優勝数");
  act(() =>
    section.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })),
  );
  clock.advance(9999);
  expect(selected(view)).toBe("優勝数");
  act(() => view.querySelector<HTMLButtonElement>("button")!.focus());
  clock.advance(30_000);
  expect(selected(view)).toBe("優勝数");
  act(() => view.querySelector<HTMLButtonElement>("button")!.blur());
  act(() =>
    section.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "touch" })),
  );
  clock.advance(10_000);
  await settleSwitch();
  expect(selected(view)).toBe("レート");
});

test("詳細に選択を引き継ぎ、自動切替せず、詳細の選択はロビーに反映しない", async () => {
  const view = await ready();
  tab(view, "レート");
  await settleSwitch();
  press(view, "もっと見る");
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector("h3")!.textContent).toBe("レート");
  clock.advance(30_000);
  expect(dialog.querySelector("h3")!.textContent).toBe("レート");
  tab(dialog, "ダブルス");
  expect(dialog.querySelector("h3")!.textContent).toBe("勝利数");
  expect(
    [...dialog.querySelectorAll('[role="tab"]')].some((item) => item.textContent === "レート"),
  ).toBe(false);
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
  await flush();
  expect(selected(view)).toBe("レート");
});

test("レート0件・取得失敗は自動切替せず、再試行はレートだけを取得する", async () => {
  const view = render(wrap()(<LobbyRankings game="four-shogi" />));
  clock.advance(0);
  normalRequest().respond(rankings);
  ratingRequest().respond({}, 503);
  await flush();
  clock.advance(30_000);
  expect(selected(view)).toBe("優勝数");
  tab(view, "レート");
  await settleSwitch();
  expect(view.textContent).toContain("レートランキングを取得できませんでした。");
  press(view, "再試行");
  expect(requests).toHaveLength(3);
  ratingRequest().respond({ entries: [] });
  await flush();
  expect(view.textContent).toContain("まだ認定を完了したプレイヤーがいません。");
  clock.advance(30_000);
  expect(selected(view)).toBe("レート");
});

test("四人将棋は詳細で撃破数を表示し、ダブルスでは撃破項目を出さない", async () => {
  const view = render(wrap()(<LobbyRankings game="four-shogi" />));
  clock.advance(0);
  requests[0]!.respond(rankings);
  await flush();
  press(view, "もっと見る");
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  act(() => dialog.querySelector<HTMLElement>('[role="tab"][id$="knockouts"]')!.click());
  await flush();
  expect(dialog.querySelector("h3")!.textContent).toBe("撃破数");
  expect(dialog.textContent).toContain("25人");
  act(() => dialog.querySelector<HTMLElement>('[role="tab"][id$="doubles"]')!.click());
  await flush();
  expect(dialog.querySelector("h3")!.textContent).toBe("勝利数");
  expect(dialog.querySelector('[role="tab"][id$="knockouts"]')).toBeNull();
});
test("旧応答の撃破数欠落は0件として表示せず詳細に取得不能を案内する", async () => {
  const view = render(wrap()(<LobbyRankings game="four-shogi" />));
  clock.advance(0);
  requests[0]!.respond({ singles: { first: [], total: [] }, doubles: { wins: [], total: [] } });
  await flush();
  press(view, "もっと見る");
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  act(() => dialog.querySelector<HTMLElement>('[role="tab"][id$="knockouts"]')!.click());
  await flush();
  expect(dialog.textContent).toContain("撃破数ランキングは現在表示できません。");
});

test("プロフィールをPortalで表示している間は自動切替しない", async () => {
  const view = await ready();
  tab(view, "レート");
  await settleSwitch();
  press(view, "参加者");
  await flush();
  expect(Boolean(document.querySelector('[aria-label="プレイヤー情報を閉じる"]'))).toBe(true);
  // カードがPortalへ移動してもProviderの表示状態で停止します。
  act(() => (document.activeElement as HTMLElement)?.blur());
  clock.advance(30_000);
  expect(selected(view)).toBe("レート");
  act(() =>
    document.querySelector<HTMLButtonElement>('[aria-label="プレイヤー情報を閉じる"]')!.click(),
  );
  await flush();
  act(() => (document.activeElement as HTMLElement)?.blur());
  clock.advance(10_000);
  await settleSwitch();
  expect(selected(view)).toBe("優勝数");
});

test("レートの更新失敗時は順位を保持し、件数の成功を妨げない", async () => {
  const view = await ready();
  tab(view, "レート");
  await settleSwitch();
  press(view, "もっと見る");
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  press(dialog, "更新");
  normalRequest().respond(rankings);
  ratingRequest().respond({}, 503);
  await flush();
  expect(dialog.textContent).toContain("1680");
  expect(dialog.textContent).toContain("レートランキングを取得できませんでした。");
  expect(requests).toHaveLength(4);
});
