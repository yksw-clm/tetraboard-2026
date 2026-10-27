import { expect, test } from "bun:test";
import { lobbyRoomCardSchema, type LobbyRoomCard } from "@tetraboard/protocol/general-lobby";
import { TournamentRooms } from "../src/features/tournaments/TournamentRooms";
import { act, clock, flush, press, render, rerender, requests, wrap } from "./harness";

const url = "/api/lobby/rooms?view=cards&game=four-shogi";
const instanceId = "11111111-1111-4111-8111-111111111111";
function room(id: string, values: Partial<LobbyRoomCard> = {}) {
  return lobbyRoomCardSchema.parse({
    id,
    instanceId,
    game: "four-shogi",
    mode: "singles",
    status: "playing",
    hostName: `ホスト${id}`,
    humanCount: 4,
    cpuCount: 0,
    capacity: 4,
    openSeats: 0,
    updatedAtMs: Number(id),
    tournamentId: 1,
    timeControl: { mainTimeMs: 0, byoyomiMs: 30000 },
    participants: Array.from({ length: 4 }, () => ({
      kind: "human",
      avatarUrl: null,
      profileTarget: null,
    })),
    ...values,
  });
}
function page(rooms: LobbyRoomCard[], nextCursor: string | null = null) {
  return { rooms, nextCursor, totalCount: rooms.length };
}
const links = (view: HTMLElement) => [...view.querySelectorAll<HTMLAnchorElement>("a")];

test("同じ大会で対局中の部屋だけを全ページから選び、共有カードに観戦リンクだけを置く", async () => {
  const view = render(wrap()(<TournamentRooms tournamentId={1} />));
  expect(view.querySelector("h2")?.textContent).toBe("進行中の部屋");
  expect(view.querySelector('[role="status"]')?.textContent).toContain("読み込んでいます");
  clock.advance(0);
  expect(requests[0]!.url).toBe(url);
  const initial = Array.from({ length: 20 }, (_, index) =>
    room(String(12345 + index), { tournamentId: 2 }),
  );
  initial[0] = room("12345");
  initial[1] = room("12346", { tournamentId: undefined });
  initial[2] = room("12347", { status: "waiting" });
  requests[0]!.respond(page(initial, "2:12364:12364"));
  await flush();
  expect(requests[1]!.url).toBe(`${url}&cursor=2%3A12364%3A12364`);
  expect(links(view)).toHaveLength(0);
  expect(view.textContent).not.toContain("進行中の部屋はありません");
  requests[1]!.respond(page([room("23456"), room("23457", { tournamentId: 2 })]));
  await flush();
  const list = view.querySelector('ul[aria-label="進行中の部屋一覧"]')!;
  expect(list.children).toHaveLength(2);
  expect(list.classList.contains("grid-cols-2")).toBe(true);
  expect(list.classList.contains("[@media(max-width:767px)]:grid-cols-1")).toBe(true);
  expect(view.textContent).toContain("ホスト12345の部屋");
  expect(view.textContent).toContain("ホスト23456の部屋");
  expect(view.textContent).not.toContain("ホスト12346");
  expect(view.textContent).not.toContain("ホスト12347");
  expect(view.textContent).not.toContain("ホスト23457");
  expect(links(view)).toHaveLength(2);
  for (const id of ["12345", "23456"]) {
    const link = links(view).find(
      (link) => link.getAttribute("aria-label") === `ルーム ${id} を観戦`,
    )!;
    expect(link.textContent).toBe("観戦");
    expect(link.getAttribute("href")).toBe(`/rooms/${id}?invite=${instanceId}&watch=1`);
  }
  expect(view.textContent).not.toContain("参加する");
  expect(view.textContent).not.toContain("大会へ");
  expect(requests.some(({ init }) => init.method === "POST")).toBe(false);
});

test("10秒更新で対局終了した部屋を除き、空表示へ更新する", async () => {
  const view = render(wrap()(<TournamentRooms tournamentId={1} />));
  clock.advance(0);
  requests[0]!.respond(page([room("12345")]));
  await flush();
  expect(links(view)).toHaveLength(1);
  clock.advance(9999);
  expect(requests).toHaveLength(1);
  clock.advance(1);
  expect(requests).toHaveLength(2);
  expect(links(view)).toHaveLength(1);
  requests[1]!.respond(page([room("12345", { status: "waiting" })]));
  await flush();
  expect(links(view)).toHaveLength(0);
  expect(view.textContent).toContain("進行中の部屋はありません");
  clock.advance(10000);
  requests[2]!.respond(page([]));
  await flush();
  expect(view.textContent).toContain("進行中の部屋はありません");
});

test("初回失敗は空表示にせず再試行でき、更新途中の失敗では既存の部屋を保持する", async () => {
  const view = render(wrap()(<TournamentRooms tournamentId={1} />));
  clock.advance(0);
  requests[0]!.respond({}, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.textContent).not.toContain("進行中の部屋はありません");
  press(view, "再試行");
  requests[1]!.respond(page([room("12345")]));
  await flush();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(links(view)).toHaveLength(1);
  press(view, "更新");
  const update = requests[2]!;
  expect(view.querySelector<HTMLButtonElement>('[aria-label="進行中の部屋を更新"]')?.disabled).toBe(
    true,
  );
  update.respond(page([room("23456")], "2:23456:23456"));
  await flush();
  expect(links(view)[0]!.getAttribute("href")).toContain("/rooms/12345?");
  requests[3]!.respond({}, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  expect(links(view)).toHaveLength(1);
  expect(links(view)[0]!.getAttribute("href")).toContain("/rooms/12345?");
  press(view, "再試行");
  requests[4]!.respond(page([]));
  await flush();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  expect(view.textContent).toContain("進行中の部屋はありません");
});

test("非表示中は取得を中止して古い応答を捨て、復帰時に再取得し大会変更も即時に絞り直す", async () => {
  const view = render(wrap()(<TournamentRooms tournamentId={1} />));
  clock.advance(0);
  requests[0]!.respond(page([room("12345"), room("23456", { tournamentId: 2 })]));
  await flush();
  expect(links(view)).toHaveLength(1);
  rerender(view, wrap()(<TournamentRooms tournamentId={2} />));
  expect(links(view)[0]!.getAttribute("href")).toContain("/rooms/23456?");
  expect(requests).toHaveLength(1);
  clock.advance(10000);
  const pending = requests[1]!;
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(pending.init.signal?.aborted).toBe(true);
    clock.advance(20000);
    expect(requests).toHaveLength(2);
    pending.respond(page([]));
    await flush();
    expect(links(view)[0]!.getAttribute("href")).toContain("/rooms/23456?");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(requests).toHaveLength(3);
    requests[2]!.respond(page([room("34567", { tournamentId: 2 })]));
    await flush();
    expect(links(view)[0]!.getAttribute("href")).toContain("/rooms/34567?");
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});
