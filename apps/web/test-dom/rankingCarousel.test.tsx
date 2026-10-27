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
for (const game of gameIds) {
  test(`${game}: 固定プレビューは指標を自動変更せず、切替操作は詳細だけに表示する`, async () => {
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
    const initial = view.textContent;
    expect(initial).toContain(gameCatalog[game].hasModes ? "シングルス・優勝数" : "勝利数");
    expect(view.querySelector('[role="tablist"]')).toBeNull();
    expect(view.querySelector('input[type="checkbox"]')).toBeNull();
    clock.advance(30_000);
    await flush();
    expect(view.textContent).toBe(initial);
    expect(requests).toHaveLength(1);
    press(view, "もっと見る");
    await flush();
    expect(document.querySelector('[role="dialog"] [role="tablist"]')).not.toBeNull();
  });
}
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
