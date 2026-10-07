import { expect, test } from "bun:test";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { roomPublicMetadataSchema } from "@tetraboard/protocol";
import { AccountStats } from "../src/features/account/AccountStats";
import { MatchHistoryCard } from "../src/features/matches/MatchHistoryCard";
import { LobbyList } from "../src/features/lobby/LobbyList";
import { PlayerCard } from "../src/features/room/PlayerCard";
import { FourShogiPlayerCard } from "../src/features/room/FourShogiPlayerCard";
import { FourReversiBoard } from "../src/features/room/FourReversiBoard";
import { playingRoom, waitingRoom, now } from "../test/fixtures/rooms";
import { playingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { match } from "../test/fixtures/matchSummary";
import { act, clock, flush, press, render, rerender, requests } from "./harness";

test("戦績の表示値・率・モード別項目・0件を取得結果から表示", async () => {
  const view = render(
    <MemoryRouter>
      <AccountStats />
    </MemoryRouter>,
  );
  clock.advance(0);
  requests[0]!.respond({
    singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
    doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
  });
  await flush();
  const metric = (label: string) =>
    [...view.querySelectorAll("dt")]
      .find((node) => node.textContent === label)!
      .parentElement!.querySelector("dd")!.textContent;
  expect(metric("優勝率")).toBe(".333");
  expect(metric("3位率")).toBe(".500");
  expect(metric("4位率")).toBe(".000");
  expect(view.textContent).toContain("対人戦のみ集計");
  act(() => view.querySelector<HTMLElement>('[role="tab"][id$="doubles"]')?.click());
  expect(metric("勝率")).toBe(".500");
  expect(metric("敗率")).toBe(".333");
  expect(view.textContent).not.toContain("優勝数");
  expect(requests).toHaveLength(1);
  await flush();
});
test("棋譜カードは同順位・CPU・日時・チーム結果・本人棋譜リンクを表示", () => {
  const detail = match(2);
  const element = <MatchHistoryCard match={detail} to={`/account/matches/${detail.id}`} />;
  const view = render(<RouterProvider router={createMemoryRouter([{ path: "*", element }])} />);
  expect(view.textContent).toContain("優勝");
  expect(view.textContent).toContain("3位");
  expect(view.textContent).toContain("CPU Lv2");
  expect(view.querySelector("time")!.getAttribute("datetime")).toBe(
    new Date(detail.startedAtMs).toISOString(),
  );
  expect(view.querySelector(`a[href="/account/matches/${detail.id}"]`)).not.toBeNull();
  const doubles = match(2, "doubles");
  rerender(
    view,
    <RouterProvider
      router={createMemoryRouter([
        { path: "*", element: <MatchHistoryCard match={doubles} to="/matches/id" /> },
      ])}
    />,
  );
  expect(view.textContent).toContain("勝利");
  expect(view.textContent).toContain("敗北");
});
test("両ゲームのプレイヤー表示は本人・host・接続・方向・時計・準備を反映", () => {
  const room = playingRoom();
  const view = render(
    <PlayerCard
      room={room}
      player={room.players[0]!}
      self
      host
      connected
      now={now}
      position="bottom"
    />,
  );
  expect(view.querySelector('[data-testid="player-card"]')!.getAttribute("aria-label")).toContain(
    "あなた、ホスト",
  );
  expect(
    view.querySelector('[data-testid="player-stone-count"]')!.getAttribute("aria-label"),
  ).toContain("黒");
  expect(view.querySelector('[aria-label^="持ち時間"]')).not.toBeNull();
  const waiting = waitingRoom();
  waiting.players[0]!.ready = true;
  rerender(
    view,
    <PlayerCard
      room={waiting}
      player={waiting.players[0]!}
      self={false}
      host={false}
      connected={false}
      now={now}
      position="left"
    />,
  );
  expect(view.textContent).toContain("準備完了");
  const shogi = playingShogiRoom();
  rerender(
    view,
    <FourShogiPlayerCard
      room={shogi}
      player={shogi.players[0]!}
      side="south"
      self
      host
      connected
      now={now}
      position="bottom"
    />,
  );
  expect(view.textContent).toContain("南");
});
test("ロビーは人数と4席を表示し、満室の参加を無効にし末尾の部屋を正しく通知", () => {
  const metadata = roomPublicMetadataSchema.parse({
    id: "12345",
    game: "four-reversi",
    mode: "singles",
    timeControl: waitingRoom().settings.timeControl,
    status: "waiting",
    hostName: "ホスト",
    humanCount: 1,
    cpuCount: 1,
    capacity: 4,
    openSeats: 2,
    updatedAtMs: now,
  });
  const joined: string[] = [],
    watched: string[] = [];
  const props = {
    rooms: [metadata, { ...metadata, id: "23456", humanCount: 4, cpuCount: 0, openSeats: 0 }],
    nextCursor: null,
    error: null,
    loading: false,
    moreLoading: false,
    onRefresh() {},
    onLoadMore() {},
    onJoin: (id: string) => joined.push(id),
    onWatch: (id: string) => watched.push(id),
  };
  const view = render(<LobbyList {...props} />);
  const rows = view.querySelectorAll("li");
  expect(rows).toHaveLength(2);
  expect(view.textContent).toContain("ホスト");
  press(rows[0]!, "参加");
  expect(rows[1]!.querySelector('[aria-label="ルーム 23456 に参加"]')).toBeNull();
  expect(joined).toEqual(["12345"]);
  press(rows[1]!, "観戦");
  expect(watched).toEqual(["23456"]);
});
test("リバーシの回転表示は元の合法座標を送信し、観戦では着手しない", () => {
  const room = playingRoom();
  if (room.status !== "playing") throw new Error("fixture");
  const legal = getLegalMoves(room.game),
    placed: unknown[] = [];
  const props = {
    game: room.game,
    legalMoves: legal,
    canPlay: true,
    onPlaceStone: (position: unknown) => placed.push(position),
  };
  const view = render(<FourReversiBoard {...props} rotation={1} />);
  expect(view.querySelectorAll("button")).toHaveLength(64);
  const pos = legal[0]!;
  const button = view.querySelector<HTMLButtonElement>(
    `[aria-label^="${"ABCDEFGH"[pos.x]}${pos.y + 1}："]`,
  )!;
  act(() => button.click());
  expect(placed).toEqual([pos]);
  rerender(view, <FourReversiBoard {...props} canPlay={false} rotation={2} />);
  expect([...view.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
});
