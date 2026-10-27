import { expect, mock, test } from "bun:test";
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
import { AccountContext } from "../src/features/account/useAccount";
import { AppButton, AppButtonLink } from "../src/shared/ui/AppButton";
import { AppPageLoading } from "../src/shared/ui/AppPageState";
import { RoomErrorPage } from "../src/features/room/RoomPage";

test("戦績の表示値・率・モード別項目・0件を取得結果から表示", async () => {
  const view = render(
    <MemoryRouter>
      <AccountStats game="four-reversi" mode="singles" />
    </MemoryRouter>,
  );
  clock.advance(0);
  requests[0]!.respond({
    singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
    doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
  });
  await flush();
  const metric = (label: string) =>
    [...view.querySelectorAll("td > span")].find(
      (node) => node.firstElementChild?.textContent === label,
    )!.lastElementChild!.textContent;
  const firstRow = view.querySelector('table[aria-label="戦績"] tr')!;
  expect([...firstRow.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
    "対局数12",
    "",
  ]);
  expect(metric("優勝率")).toBe(".333");
  expect(metric("3位率")).toBe(".500");
  expect(metric("4位率")).toBe(".000");
  expect(view.textContent).toContain("対人戦のみ集計");
  rerender(
    view,
    <MemoryRouter>
      <AccountStats game="four-reversi" mode="doubles" />
    </MemoryRouter>,
  );
  expect(metric("勝率")).toBe(".500");
  expect(metric("敗率")).toBe(".333");
  expect(view.textContent).not.toContain("優勝数");
  expect(requests).toHaveLength(1);
  await flush();
});
test("棋譜カードは同順位・CPU・日時・チーム結果・本人棋譜リンクを表示", () => {
  const detail = match(2);
  detail.moveCount = 60;
  const element = <MatchHistoryCard match={detail} to={`/account/matches/${detail.id}`} />;
  const view = render(<RouterProvider router={createMemoryRouter([{ path: "*", element }])} />);
  expect(view.textContent).toContain("優勝");
  expect(view.textContent).toContain("3位");
  expect(view.textContent).toContain("CPU Lv2");
  expect(view.textContent).toContain("60手");
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
  expect(view.textContent).not.toContain("60手");
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
    game: "four-reversi" as const,
    rooms: [
      {
        ...metadata,
        instanceId: "11111111-1111-4111-8111-111111111111",
        participants: [
          { kind: "human" as const, avatarUrl: null, profileTarget: null },
          { kind: "cpu" as const, level: 1 as const },
        ],
      },
      {
        ...metadata,
        instanceId: "11111111-1111-4111-8111-111111111111",
        participants: Array.from({ length: 4 }, () => ({
          kind: "human" as const,
          avatarUrl: null,
          profileTarget: null,
        })),
        id: "23456",
        humanCount: 4,
        cpuCount: 0,
        openSeats: 0,
      },
    ],
    nextCursor: null,
    error: null,
    loading: false,
    isInitialLoading: false,
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
  expect(view.textContent).toContain("四人リバーシ");
  press(rows[0]!, "参加する");
  expect(
    rows[1]!.querySelector<HTMLButtonElement>('[aria-label="ルーム 23456 に参加"]')!.disabled,
  ).toBe(true);
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

test("処理中ボタンは内容・ref・読み上げ名を保ち、解除するまで再操作しない", () => {
  const clicked = mock(() => {});
  const ref = { current: null as HTMLButtonElement | null };
  const button = (pending: boolean) => (
    <AppButton ref={ref} isPending={pending} onPress={clicked} aria-label="対局を保存">
      保存
    </AppButton>
  );
  const view = render(button(false));
  press(view, "保存");
  expect(clicked).toHaveBeenCalledTimes(1);
  rerender(view, button(true));
  expect(ref.current).toBe(view.querySelector("button"));
  expect(ref.current!.getAttribute("aria-label")).toBe("対局を保存");
  expect(ref.current!.textContent).toContain("保存");
  expect(ref.current!.getAttribute("aria-disabled")).toBe("true");
  expect(ref.current!.querySelector('[data-slot="pending-spinner"]')).not.toBeNull();
  press(view, "保存");
  expect(clicked).toHaveBeenCalledTimes(1);
  rerender(view, button(false));
  press(view, "保存");
  expect(clicked).toHaveBeenCalledTimes(2);
  expect(ref.current!.querySelector('[data-slot="pending-spinner"]')).toBeNull();
});

test("棋譜遷移は対象リンクだけ処理中にし、履歴stateを渡して遷移する", async () => {
  const first = match(1),
    second = match(2);
  let complete!: (value: null) => void;
  const loader = mock(
    () =>
      new Promise<null>((resolve) => {
        complete = resolve;
      }),
  );
  const router = createMemoryRouter(
    [
      {
        path: "/account",
        element: (
          <>
            <MatchHistoryCard match={first} to={`/account/matches/${first.id}`} />
            <MatchHistoryCard match={second} to={`/account/matches/${second.id}`} />
          </>
        ),
      },
      { path: "/account/matches/:matchId", loader, element: <p>棋譜取得成功</p> },
    ],
    { initialEntries: [{ pathname: "/account", state: { historyGame: "four-shogi" } }] },
  );
  const view = render(<RouterProvider router={router} />);
  const links = [...view.querySelectorAll<HTMLAnchorElement>("a")];
  act(() => links[0]!.click());
  await flush();
  expect(links[0]!.getAttribute("aria-busy")).toBe("true");
  expect(links[1]!.querySelector('[data-slot="pending-spinner"]')).toBeNull();
  expect(view.textContent).not.toContain("棋譜を読み込んでいます");
  act(() => links[0]!.click());
  expect(loader).toHaveBeenCalledTimes(1);
  act(() => complete(null));
  await flush();
  expect(router.state.location.pathname).toBe(`/account/matches/${first.id}`);
  expect(router.state.location.state).toEqual({ historyGame: "four-shogi" });
  router.dispose();
});

test("中央の読み込み表示はゲーム別テーマを持ち、ルーム404からロビーへ戻れる", async () => {
  const view = render(<AppPageLoading message="ロビーを読み込んでいます…" theme="four-shogi" />);
  expect(view.querySelector("main")!.className).toContain("lobby-background");
  expect(view.querySelector("main")!.className).toContain("game-theme-four-shogi");
  expect(view.querySelector('[role="status"]')!.textContent).toContain("ロビーを読み込んでいます");
  expect(view.querySelector('[data-slot="spinner"]')).not.toBeNull();
  const router = createMemoryRouter(
    [
      {
        path: "/rooms/:id",
        loader: () => {
          throw new Response(null, { status: 404 });
        },
        element: null,
        errorElement: <RoomErrorPage />,
        hydrateFallbackElement: <AppPageLoading message="ルームを読み込んでいます…" />,
      },
      { path: "/games/four-reversi", element: <p>ロビー</p> },
    ],
    { initialEntries: ["/rooms/12345"] },
  );
  rerender(
    view,
    <AccountContext.Provider
      value={{ user: null, loading: false, error: null, refresh: async () => {}, update: () => {} }}
    >
      <RouterProvider router={router} />
    </AccountContext.Provider>,
  );
  await flush();
  expect(view.querySelector('[role="alert"]')!.textContent).toBe("ルームが見つかりません。");
  expect(view.querySelector("main")!.className).toContain("lobby-background");
  act(() => view.querySelector<HTMLAnchorElement>('a[href="/games/four-reversi"]')!.click());
  await flush();
  expect(router.state.location.pathname).toBe("/games/four-reversi");
  router.dispose();
});

test("処理中リンクはhrefと内容を維持し、クリックとハンドラを抑止する", () => {
  const clicked = mock(() => {});
  const view = render(
    <MemoryRouter>
      <AppButtonLink to="/matches/example" isPending onClick={clicked}>
        棋譜を見る
      </AppButtonLink>
    </MemoryRouter>,
  );
  const link = view.querySelector<HTMLAnchorElement>("a")!;
  expect(link.getAttribute("href")).toBe("/matches/example");
  expect(link.textContent).toContain("棋譜を見る");
  expect(link.getAttribute("aria-disabled")).toBe("true");
  act(() => link.click());
  expect(clicked).not.toHaveBeenCalled();
});
