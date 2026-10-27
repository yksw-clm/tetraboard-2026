import { expect, test } from "bun:test";
import { useLocation } from "react-router";
import type { TournamentLobbySections, TournamentPublic } from "@tetraboard/protocol";
import { TournamentEntrance } from "../src/features/tournaments/TournamentEntrance";
import { profile } from "../test/fixtures/account";
import { act, clock, flush, press, render, rerender, requests, wrap } from "./harness";

const lobbyUrl = "/api/tournaments/lobby?view=sections&game=four-shogi";
function tournament(
  id: number,
  status: TournamentPublic["status"],
  entryCount = 8,
): TournamentPublic {
  return {
    id,
    name: `大会${id}`,
    description: "説明",
    rulesDescription: "案内",
    status,
    entryCount,
    startsAtMs: Date.now() + (status === "upcoming" ? 3600000 : -3600000),
    endsAtMs: Date.now() + (status === "settling" || status === "finished" ? -1000 : 180000),
    finalizedAtMs: status === "finished" ? Date.now() : null,
    waitingCount: 0,
    playingCount: 0,
    pendingCount: 0,
    completedCount: 0,
    ruleVersion: 1,
  };
}
function sections(
  current: TournamentPublic[] = [],
  upcoming: TournamentPublic[] = [],
): TournamentLobbySections {
  return { current, upcoming, serverTimeMs: Date.now() };
}
const latestPublic = () => requests.filter(({ url }) => url === lobbyUrl).at(-1)!;
const latestParticipation = (id: number) =>
  requests.filter(({ url }) => url === `/api/tournaments/${id}/participation`).at(-1)!;
const participate = (id: number, entered: boolean) =>
  latestParticipation(id).respond({
    entered,
    status: "idle",
    controller: "none",
    controllerVersion: 0,
  });
const card = (view: HTMLElement, id: number) =>
  view.querySelector<HTMLElement>(
    `[role="article"][aria-labelledby="tournament-${id}-entrance-title"]`,
  )!;
function Location() {
  const location = useLocation();
  return <output>{JSON.stringify({ path: location.pathname, state: location.state })}</output>;
}

test("大会と次回の全カードを分け、人数をリンク左へ置き、終了済みには参加操作を出さない", async () => {
  const view = render(
    wrap(null)(
      <>
        <TournamentEntrance />
        <Location />
      </>,
    ),
  );
  clock.advance(0);
  const data = sections(
    [tournament(1, "active", 12), tournament(2, "settling", 11), tournament(3, "finished", 10)],
    [tournament(4, "upcoming", 9), tournament(5, "upcoming", 0)],
  );
  data.serverTimeMs += 120000;
  latestPublic().respond(data);
  await flush();
  expect([...view.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([
    "大会",
    "次回の大会",
  ]);
  expect([...view.querySelectorAll("h3")].map((node) => node.textContent)).toEqual([
    "大会1",
    "大会2",
    "大会3",
    "大会4",
    "大会5",
  ]);
  expect(view.textContent).not.toContain("日本時間");
  expect(view.textContent).not.toContain("現在12人");
  expect(card(view, 1).textContent).toContain("終了まであと1分");
  for (const [id, count] of [
    [1, 12],
    [2, 11],
    [3, 10],
    [4, 9],
    [5, 0],
  ]) {
    const current = card(view, id!);
    const number = current.querySelector("strong")!;
    expect(number.textContent).toBe(String(count));
    expect(number.classList.contains("text-[30px]")).toBe(true);
    expect(number.parentElement!.textContent).toBe(
      `${count}${id === 1 ? "人が参加中" : "人がエントリー中"}`,
    );
    expect(number.parentElement!.nextElementSibling!.tagName).toBe("A");
    expect(number.parentElement!.nextElementSibling!.getAttribute("href")).toBe(
      `/tournaments/${id}`,
    );
  }
  for (const id of [2, 3]) {
    expect(card(view, id).querySelectorAll("a")).toHaveLength(1);
    expect(card(view, id).querySelectorAll("button")).toHaveLength(0);
  }
  expect(card(view, 3).textContent).toContain("結果を見る");
  expect(requests.some(({ url }) => url.endsWith("/participation"))).toBe(false);
  const guestEntry = [...card(view, 4).querySelectorAll("a")].find(
    (link) => link.textContent === "ゲストでエントリー",
  )!;
  act(() => guestEntry.click());
  await flush();
  expect(JSON.parse(view.querySelector("output")!.textContent!)).toEqual({
    path: "/tournaments/4",
    state: { tournamentEntryRequested: true },
  });
  expect(requests.some(({ init }) => init.method === "POST")).toBe(false);
});

test("空の区分は見出しごと非表示にし、ゲーム変更後の古い応答を表示しない", async () => {
  const view = render(wrap(null)(<TournamentEntrance />));
  clock.advance(0);
  const old = latestPublic();
  rerender(view, wrap(null)(<TournamentEntrance game="gomoku" />));
  expect(old.init.signal?.aborted).toBe(true);
  clock.advance(0);
  expect(requests.at(-1)!.url).toBe("/api/tournaments/lobby?view=sections&game=gomoku");
  old.respond(sections([tournament(1, "active")]));
  requests.at(-1)!.respond(sections());
  await flush();
  expect(view.querySelector("section")).toBeNull();
  expect(view.querySelector("h3")).toBeNull();
  rerender(view, wrap(null)(<TournamentEntrance />));
  clock.advance(0);
  latestPublic().respond(sections([], [tournament(3, "upcoming")]));
  await flush();
  expect([...view.querySelectorAll("h2")].map((node) => node.textContent)).toEqual(["次回の大会"]);
  clock.advance(5000);
  latestPublic().respond(sections());
  await flush();
  expect(view.querySelector("section")).toBeNull();
});

test("公開情報は5秒更新し、非表示時は中止・復帰時は再取得、失敗時は既存カードを保持する", async () => {
  const view = render(wrap(null)(<TournamentEntrance />));
  clock.advance(0);
  latestPublic().respond(sections([tournament(1, "active", 8)]));
  await flush();
  const count = () => requests.filter(({ url }) => url === lobbyUrl).length;
  clock.advance(4999);
  expect(count()).toBe(1);
  clock.advance(1);
  expect(count()).toBe(2);
  const inFlight = latestPublic();
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(inFlight.init.signal?.aborted).toBe(true);
    clock.advance(10000);
    expect(count()).toBe(2);
    inFlight.respond(sections([tournament(99, "active")]));
    await flush();
    expect(view.textContent).not.toContain("大会99");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(count()).toBe(3);
    latestPublic().respond({}, 503);
    await flush();
    expect(card(view, 1).textContent).toContain("8人が参加中");
    expect(view.querySelector('[role="alert"]')?.textContent).toContain(
      "大会の情報を取得できませんでした。",
    );
    press(view, "再試行");
    clock.advance(0);
    latestPublic().respond(sections([tournament(1, "active", 9)]));
    await flush();
    expect(card(view, 1).textContent).toContain("9人が参加中");
    expect(view.querySelector('[role="alert"]')).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("公開カードは本人状態より先に表示し、各大会の確認・失敗・取得済み状態を独立して扱う", async () => {
  const view = render(wrap(profile)(<TournamentEntrance />));
  clock.advance(0);
  const data = sections(
    [tournament(1, "active"), tournament(2, "finished")],
    [tournament(3, "upcoming")],
  );
  latestPublic().respond(data);
  await flush();
  expect(view.querySelectorAll("h3")).toHaveLength(3);
  expect(card(view, 1).querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  expect(requests.some(({ url }) => url === "/api/tournaments/2/participation")).toBe(false);
  participate(1, true);
  latestParticipation(3).respond({}, 503);
  await flush();
  expect(card(view, 1).textContent).toContain("大会に参加");
  expect(
    [...card(view, 1).querySelectorAll("a")].some((link) => link.textContent === "大会に参加"),
  ).toBe(true);
  expect(card(view, 3).querySelector('[role="alert"]')?.textContent).toContain(
    "参加状態を確認できませんでした。",
  );
  const entry = [...card(view, 3).querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "エントリー",
  )!;
  expect(entry.disabled).toBe(true);
  press(card(view, 3), "再試行");
  clock.advance(0);
  latestPublic().respond(data);
  await flush();
  latestParticipation(1).respond({}, 503);
  participate(3, true);
  await flush();
  expect(
    [...card(view, 1).querySelectorAll("a")].some((link) => link.textContent === "大会に参加"),
  ).toBe(true);
  expect(card(view, 1).querySelector('[role="alert"]')).not.toBeNull();
  expect(card(view, 3).textContent).toContain("エントリー済み");
  expect(card(view, 3).querySelector('[role="alert"]')).toBeNull();
});

test("アカウント切替で本人状態を取り違えず、遅い旧応答を適用しない", async () => {
  const view = render(wrap(profile)(<TournamentEntrance />));
  clock.advance(0);
  const data = sections([], [tournament(1, "upcoming")]);
  latestPublic().respond(data);
  await flush();
  const old = latestParticipation(1);
  const other = { ...profile, username: "second_player" };
  rerender(view, wrap(other)(<TournamentEntrance />));
  expect(old.init.signal?.aborted).toBe(true);
  expect(view.textContent).not.toContain("エントリー済み");
  clock.advance(0);
  latestPublic().respond(data);
  await flush();
  old.respond({ entered: true, status: "idle", controller: "none", controllerVersion: 0 });
  participate(1, false);
  await flush();
  expect(view.textContent).not.toContain("エントリー済み");
  expect(
    [...card(view, 1).querySelectorAll("a")].some((link) => link.textContent === "エントリー"),
  ).toBe(true);
});
