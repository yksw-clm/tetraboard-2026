import { expect, test } from "bun:test";
import type { TournamentDetail, TournamentStanding } from "@tetraboard/protocol";
import { TournamentStandings } from "../src/features/tournaments/TournamentStandings";
import { PlayerProfileProvider } from "../src/features/players/PlayerProfileProvider";
import { act, clock, flush, render, rerender, requests, wrap } from "./harness";

const profileId = "10000000-0000-4000-8000-000000000001";
function row(rank: number | null, name = "あいうえおかきくけこ"): TournamentStanding {
  return {
    rank,
    name,
    username: name,
    profileId: null,
    avatarUrl: null,
    pointsUnits: 84,
    games: rank ? 2 : 0,
    first: 1,
    second: 1,
    third: 0,
    fourth: 0,
    knockouts: 3,
    rankSum: 3,
  };
}
function detail(rows: TournamentStanding[]): TournamentDetail {
  return {
    tournament: {
      id: 1,
      name: "大会",
      description: "",
      rulesDescription: "",
      startsAtMs: Date.now() - 1000,
      endsAtMs: Date.now() + 60000,
      status: "active",
      entryCount: rows.length,
      waitingCount: 0,
      playingCount: 0,
      pendingCount: 0,
      completedCount: 1,
      ruleVersion: 1,
      finalizedAtMs: null,
    },
    standings: rows,
    self: null,
    nextCursor: null,
    nextTournament: null,
  };
}
function page(rows: TournamentStanding[]) {
  return render(
    wrap()(
      <PlayerProfileProvider>
        <TournamentStandings detail={detail(rows)} />
      </PlayerProfileProvider>,
    ),
  );
}

test("公開IDでゲストの本人重複を防ぎ、順位更新後も開いた成績を本人の行に保持する", () => {
  const first = { ...row(1, "ゲスト一人目"), username: null, isGuest: true, profileId };
  const self = {
    ...row(2, "ゲスト本人"),
    username: null,
    isGuest: true,
    profileId: "10000000-0000-4000-8000-000000000002",
  };
  const tree = (rows: TournamentStanding[]) =>
    wrap()(
      <PlayerProfileProvider>
        <TournamentStandings detail={{ ...detail(rows), self }} />
      </PlayerProfileProvider>,
    );
  const view = render(tree([first, self]));
  expect(view.querySelectorAll('th[scope="row"]')).toHaveLength(2);
  act(() =>
    view.querySelector<HTMLButtonElement>('[aria-label="ゲスト本人の成績を表示"]')!.click(),
  );
  rerender(
    view,
    tree([
      { ...self, rank: 1 },
      { ...first, rank: 2 },
    ]),
  );
  expect(view.querySelectorAll('th[scope="row"]')).toHaveLength(2);
  const button = view.querySelector('[aria-label="ゲスト本人の成績を閉じる"]')!;
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(
    view.querySelector('[aria-label="ゲスト一人目の成績を表示"]')?.getAttribute("aria-expanded"),
  ).toBe("false");
});

test("同順位の上位3位は同色、4位と未対局は通常色とし、勝ち点の数字と単位を分ける", () => {
  const view = page([
    row(1, "一位"),
    row(1, "同率一位"),
    row(2, "二位"),
    row(3, "三位"),
    row(4, "四位"),
    row(null, "未対局"),
  ]);
  const ranks = [...view.querySelectorAll("tbody tr > td:first-child")].filter((cell) =>
    cell.parentElement?.querySelector('th[scope="row"]'),
  );
  expect(ranks[0]!.className).toBe(ranks[1]!.className);
  expect(new Set(ranks.slice(1, 5).map((cell) => cell.className)).size).toBe(4);
  expect(ranks[4]!.className).toBe(ranks[5]!.className);
  expect(ranks[5]!.textContent).toBe("—");
  const points = view.querySelector("tbody tr td:nth-child(3)")!;
  expect(points.querySelector("strong")?.textContent).toBe("7");
  expect(points.querySelector("span")?.textContent).toBe("点");
});

test("各行の成績を独立して展開し、本人・未対局を維持し、プロフィール操作とは分ける", async () => {
  const self = { ...row(null, "本人"), self: true };
  const view = page([row(1), self]);
  const triggers = [...view.querySelectorAll<HTMLButtonElement>("button[aria-controls]")];
  const first = triggers[0]!,
    second = triggers[1]!;
  expect(first.getAttribute("aria-expanded")).toBe("false");
  act(() => first.click());
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(second.getAttribute("aria-expanded")).toBe("false");
  const stats = document.getElementById(first.getAttribute("aria-controls")!)!;
  expect(stats.closest("tr")!.hidden).toBe(false);
  expect([...stats.querySelectorAll("dt")].map((cell) => cell.textContent)).toEqual([
    "対局数",
    "優勝数",
    "2位数",
    "3位数",
    "4位数",
    "撃破数",
    "平均順位",
  ]);
  expect(stats.textContent).toContain("1.50");
  expect(requests).toHaveLength(0);
  act(() => second.click());
  const selfStats = document.getElementById(second.getAttribute("aria-controls")!)!;
  expect(selfStats.textContent).toContain("平均順位—");
  expect(view.textContent).toContain("あなた");
  act(() => first.click());
  expect(stats.closest("tr")!.hidden).toBe(true);
  expect(selfStats.closest("tr")!.hidden).toBe(false);
  await flush();
});

test("ゲストも公開プロフィールでカードを開き、順位表のラベルを省き、退会者と旧応答には操作を設けない", async () => {
  const view = page([
    { ...row(1, "ゲスト参加者"), isGuest: true, profileId },
    { ...row(2, "退会したプレイヤー"), username: null, profileId: null },
    { ...row(3, "旧応答"), profileId: undefined },
  ]);
  const player = view.querySelector<HTMLButtonElement>(
    '[aria-label="ゲスト参加者のプレイヤー情報"]',
  )!;
  expect(player.textContent).toBe("ゲスト参加者");
  expect(view.querySelectorAll('button[aria-label$="のプレイヤー情報"]')).toHaveLength(1);
  act(() =>
    player.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })),
  );
  clock.advance(300);
  await flush();
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url, "http://localhost").searchParams.get("profileId")).toBe(
    profileId,
  );
  expect(new URL(requests[0]!.url, "http://localhost").searchParams.get("game")).toBe("four-shogi");
  act(() => player.click());
  expect(player.getAttribute("aria-expanded")).toBe("true");
  expect(
    view
      .querySelector('button[aria-label="ゲスト参加者の成績を表示"]')
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await flush();
  expect(player.getAttribute("aria-expanded")).toBe("false");
});
