import { expect, test } from "bun:test";
import type { TournamentList as ListData, TournamentListItem } from "@tetraboard/protocol";
import { TournamentList } from "../src/features/tournaments/TournamentList";
import { act, clock, flush, press, render, rerender, requests, wrap } from "./harness";

const url = "/api/tournaments?game=all";
const cursor = "1790899200000:21";
const moreUrl = `${url}&cursor=${encodeURIComponent(cursor)}`;
const latest = () => requests.at(-1)!;
function tournament(
  id: number,
  status: TournamentListItem["status"] = "finished",
  winners: TournamentListItem["winners"] = [],
): TournamentListItem {
  return {
    id,
    game: "four-shogi",
    name: `大会${id}`,
    startsAtMs: Date.UTC(2026, 9, 20, 9),
    endsAtMs: Date.UTC(2026, 9, 20, 10),
    status,
    entryCount: 12,
    winners,
  };
}
function page(tournaments: TournamentListItem[], nextCursor: string | null = null): ListData {
  return { tournaments, nextCursor, serverTimeMs: Date.now() };
}
const titles = (view: HTMLElement) =>
  [...view.querySelectorAll("h3")].map((node) => node.textContent);
const card = (view: HTMLElement, id: number) =>
  view.querySelector<HTMLElement>(
    `[role="article"][aria-labelledby="tournament-list-${id}-name"]`,
  )!;
const firstPage = () => Array.from({ length: 20 }, (_, index) => tournament(40 - index));

test("全公開状態の大会を表示し、確定した優勝者全員の名前・アイコンと表彰なしを区別する", async () => {
  const images: HTMLImageElement[] = [];
  const NativeImage = window.Image;
  window.Image = class extends NativeImage {
    constructor(width?: number, height?: number) {
      super(width, height);
      images.push(this);
    }
  };
  try {
    const view = render(wrap()(<TournamentList game="all" />));
    expect(view.querySelector("h2")?.textContent).toBe("大会一覧");
    expect(view.querySelector('[role="status"]')?.textContent).toContain("読み込んでいます");
    clock.advance(0);
    expect(latest().url).toBe(url);
    expect(latest().init.cache).toBe("no-store");
    latest().respond(
      page([
        tournament(5, "upcoming", [{ name: "未確定の人", avatarUrl: null }]),
        tournament(4, "active"),
        tournament(3, "settling"),
        tournament(2, "finished", [
          { name: "優勝者いち", avatarUrl: "/api/avatars/winner-one.webp" },
          { name: "優勝者に", avatarUrl: null, isGuest: true },
        ]),
        tournament(1),
      ]),
    );
    await flush();
    expect(titles(view)).toEqual(["大会5", "大会4", "大会3", "大会2", "大会1"]);
    expect(card(view, 5).textContent).toContain("エントリー受付中");
    expect(card(view, 5).textContent).toContain("12人がエントリー中");
    expect(card(view, 4).textContent).not.toContain("人がエントリー中");
    expect(card(view, 4).textContent).toContain("開催中");
    expect(card(view, 3).textContent).toContain("結果発表待ち");
    expect(card(view, 2).textContent).toContain("結果発表");
    expect(card(view, 2).textContent).toContain("同率優勝");
    expect(card(view, 2).textContent).toContain("優勝者いち");
    expect(card(view, 2).textContent).toContain("優勝者にゲスト");
    expect(card(view, 2).querySelectorAll("li")).toHaveLength(2);
    expect(images).toHaveLength(1);
    expect(images[0]!.src).toBe("https://tetraboard.test/api/avatars/winner-one.webp");
    Object.defineProperties(images[0]!, {
      complete: { value: true },
      naturalWidth: { value: 32 },
    });
    act(() => images[0]!.dispatchEvent(new Event("load")));
    await flush();
    expect(card(view, 2).querySelector('img[src="/api/avatars/winner-one.webp"]')).not.toBeNull();
    expect(card(view, 1).textContent).toContain("表彰なし");
    expect(view.textContent).not.toContain("未確定の人");
    for (const id of [3, 4, 5]) {
      expect(card(view, id).textContent).not.toContain("優勝");
      expect(card(view, id).textContent).not.toContain("表彰なし");
      expect(card(view, id).querySelector("a")?.textContent).toBe("詳細へ");
    }
    expect(card(view, 2).querySelector("a")?.getAttribute("href")).toBe("/tournaments/2");
    expect(card(view, 2).querySelector("a")?.textContent).toBe("結果を見る");
    expect(view.textContent).toContain("四人将棋");
    expect(view.textContent).not.toContain("日本時間");
    expect(view.querySelectorAll("button")).toHaveLength(0);
    expect(requests).toHaveLength(1);
    clock.advance(5000);
    latest().respond(page([{ ...tournament(5, "upcoming"), entryCount: 0 }]));
    await flush();
    expect(card(view, 5).textContent).toContain("0人がエントリー中");
  } finally {
    window.Image = NativeImage;
  }
});

test("20件から追加取得し、重複を除き、更新は全ページ成功まで保留して失敗時は一覧を保持する", async () => {
  const view = render(wrap()(<TournamentList game="all" />));
  clock.advance(0);
  latest().respond(page(firstPage(), cursor));
  await flush();
  expect(titles(view)).toHaveLength(20);
  press(view, "もっと見る");
  expect(latest().url).toBe(moreUrl);
  clock.advance(5000);
  expect(requests).toHaveLength(2);
  latest().respond(page([tournament(21), tournament(20)]));
  await flush();
  expect(titles(view)).toHaveLength(21);
  expect(titles(view).at(-1)).toBe("大会20");
  expect(view.querySelector("button")).toBeNull();

  clock.advance(5000);
  expect(latest().url).toBe(url);
  const refreshed = firstPage();
  refreshed[0] = { ...refreshed[0]!, name: "更新後の大会40" };
  latest().respond(page(refreshed, cursor));
  await flush();
  expect(latest().url).toBe(moreUrl);
  expect(titles(view)[0]).toBe("大会40");
  expect(titles(view)).toHaveLength(21);
  latest().respond({}, 503);
  await flush();
  expect(titles(view)[0]).toBe("大会40");
  expect(titles(view)).toHaveLength(21);
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("取得できませんでした");

  press(view, "再試行");
  expect(latest().url).toBe(url);
  latest().respond(page(refreshed, cursor));
  await flush();
  latest().respond(page([tournament(20)]));
  await flush();
  expect(titles(view)[0]).toBe("更新後の大会40");
  expect(titles(view)).toHaveLength(21);
  expect(view.querySelector('[role="alert"]')).toBeNull();
});

test("初回のAPI失敗・不正な応答は空一覧に置き換えず、再試行の成功後に空メッセージを出す", async () => {
  const view = render(wrap()(<TournamentList game="gomoku" />));
  clock.advance(0);
  expect(latest().url).toBe("/api/tournaments?game=gomoku");
  latest().respond({}, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.textContent).not.toContain("公開されている大会はありません");
  press(view, "再試行");
  latest().respond({ tournaments: [], nextCursor: null });
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.textContent).not.toContain("公開されている大会はありません");
  press(view, "再試行");
  latest().respond(page([]));
  await flush();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(view.textContent).toContain("公開されている大会はありません");
  expect(view.querySelectorAll("button")).toHaveLength(0);
});

test("5秒更新は多重取得せず、非表示では中止し、復帰時に再取得して中止前の応答を破棄する", async () => {
  const view = render(wrap()(<TournamentList game="all" />));
  clock.advance(0);
  latest().respond(page([tournament(1)]));
  await flush();
  clock.advance(4999);
  expect(requests).toHaveLength(1);
  clock.advance(1);
  expect(requests).toHaveLength(2);
  const inFlight = latest();
  clock.advance(5000);
  expect(requests).toHaveLength(2);
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(inFlight.init.signal?.aborted).toBe(true);
    clock.advance(10000);
    expect(requests).toHaveLength(2);
    inFlight.respond(page([tournament(99)]));
    await flush();
    expect(titles(view)).toEqual(["大会1"]);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(requests).toHaveLength(3);
    latest().respond(page([tournament(2)]));
    await flush();
    expect(titles(view)).toEqual(["大会2"]);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("game変更時は旧リクエストと一覧を破棄し、別gameの応答を表示しない", async () => {
  const view = render(wrap()(<TournamentList game="all" />));
  clock.advance(0);
  const old = latest();
  rerender(view, wrap()(<TournamentList game="reversi" />));
  expect(old.init.signal?.aborted).toBe(true);
  clock.advance(0);
  expect(latest().url).toBe("/api/tournaments?game=reversi");
  old.respond(page([tournament(1)]));
  latest().respond(page([{ ...tournament(2), game: "reversi" }]));
  await flush();
  expect(titles(view)).toEqual(["大会2"]);
  expect(card(view, 2).textContent).not.toContain("リバーシ");
  rerender(view, wrap()(<TournamentList game="shogi" />));
  expect(titles(view)).toHaveLength(0);
  clock.advance(0);
  latest().respond(page([{ ...tournament(3), game: "reversi" }]));
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  expect(titles(view)).toHaveLength(0);
});

test("追加取得の失敗や循環cursorでは取得済みの大会と続きを保持する", async () => {
  const view = render(wrap()(<TournamentList game="all" />));
  clock.advance(0);
  latest().respond(page([tournament(2)], cursor));
  await flush();
  press(view, "もっと見る");
  latest().respond({}, 503);
  await flush();
  expect(titles(view)).toEqual(["大会2"]);
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("続きの大会一覧");
  press(view, "もっと見る");
  latest().respond(page([tournament(1)], cursor));
  await flush();
  expect(titles(view)).toEqual(["大会2"]);
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  expect(requests).toHaveLength(3);
  press(view, "もっと見る");
  latest().respond(page([tournament(1)]));
  await flush();
  expect(titles(view)).toEqual(["大会2", "大会1"]);
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(view.querySelector("button")).toBeNull();
});
