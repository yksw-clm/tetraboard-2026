import { expect, test } from "bun:test";
import {
  Routes,
  Route,
  createMemoryRouter,
  matchRoutes,
  RouterProvider,
  useLocation,
} from "react-router";
import { MatchmakingPage } from "../src/features/matchmaking/MatchmakingPage";
import { ShogiMatchmakingDialog } from "../src/features/matchmaking/ShogiMatchmakingDialog";
import { AccountContext } from "../src/features/account/useAccount";
import {
  QueueControllerContext,
  QueueDocumentController,
} from "../src/shared/QueueDocumentController";
import { profile } from "../test/fixtures/account";
import { act, clock, flush, press, render, requests, wrap, denyStorage } from "./harness";
const identity = "00000000-0000-4000-8000-000000000001";
const user = { ...profile, profileId: identity };
function Path() {
  const location = useLocation();
  return <p data-path>{location.pathname}</p>;
}
function page() {
  const path = "/games/four-reversi/matchmaking";
  const controller = new QueueDocumentController({
    isReload: () => false,
    locks: () => undefined,
    channel: () => null,
  });
  const view = render(
    <QueueControllerContext value={controller}>
      {wrap(
        user,
        path,
      )(
        <Routes>
          <Route path={path} element={<MatchmakingPage />} />
          <Route path="*" element={<Path />} />
        </Routes>,
      )}
    </QueueControllerContext>,
  );
  return { view, controller };
}
const latest = (path: string) => requests.filter((r) => r.url.includes(path)).at(-1)!;
const shogiLobby = "/games/shogi";
const shogiDialogUrl = shogiLobby + "?matchmaking=1";
const shogiStatusUrl = "/api/matchmaking/shogi?";
const shogiRatingUrl = "/api/matchmaking/shogi/rating";
const shogiJoinUrl = "/api/matchmaking/shogi/join";
const shogiCancelUrl = "/api/matchmaking/shogi/cancel";
const shogiIdle = () => ({ status: "idle", enabled: true, serverNowMs: Date.now() });
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
const activeDialog = () => dialogs().at(-1)!;
function shogiPage(viewer = user, rejoin = false) {
  const controller = new QueueDocumentController({
    isReload: () => false,
    locks: () => undefined,
    channel: () => null,
  });
  function Lobby() {
    const { search } = useLocation();
    return search === "?matchmaking=1" ? <ShogiMatchmakingDialog /> : null;
  }
  const router = createMemoryRouter(
    [
      { path: shogiLobby, element: <Lobby /> },
      { path: "*", element: <Path /> },
    ],
    {
      initialEntries: [
        shogiLobby,
        {
          pathname: shogiLobby,
          search: "?matchmaking=1",
          state: rejoin ? { matchmakingRejoin: true } : null,
        },
      ],
    },
  );
  render(
    <AccountContext
      value={{
        user: viewer,
        loading: false,
        error: null,
        refresh: async () => {},
        update: () => {},
      }}
    >
      <QueueControllerContext value={controller}>
        <RouterProvider router={router} />
      </QueueControllerContext>
    </AccountContext>,
  );
  return router;
}

async function respondToJoin() {
  const request = latest(shogiJoinUrl);
  const waiting = {
    ...shogiIdle(),
    ...JSON.parse(String(request.init.body)),
    status: "waiting",
    version: 1,
    joinedAtMs: Date.now(),
  };
  request.respond(waiting);
  await flush();
  return waiting;
}

async function startShogiSearch() {
  latest(shogiStatusUrl).respond(shogiIdle());
  latest(shogiRatingUrl).respond({ status: "placement", games: 2 });
  await flush();
  press(activeDialog(), "対戦相手を探す");
  await flush();
  return respondToJoin();
}

function assignment(opponent: "cpu" | "human") {
  return {
    opponent,
    matchId: crypto.randomUUID(),
    roomId: "12345",
    instanceId: crypto.randomUUID(),
    expiresAtMs: Date.now() + 30000,
    membership: { playerId: crypto.randomUUID(), role: "host", token: "a".repeat(64) },
  };
}

test("将棋ダイアログに認定進捗を表示し、開き直すと最新レートを取得する", async () => {
  const router = shogiPage();
  expect(activeDialog().textContent).toContain("レートを読み込んでいます");
  latest(shogiStatusUrl).respond(shogiIdle());
  latest(shogiRatingUrl).respond({ status: "placement", games: 2 });
  await flush();
  expect(activeDialog().textContent).toContain("認定中");
  expect(activeDialog().textContent).toContain("2 / 5局");
  expect(activeDialog().textContent).toContain("将棋のレート戦");
  expect(activeDialog().textContent).not.toContain("15秒で相手が見つからなければ");
  expect(activeDialog().textContent).not.toContain("13歳以上");
  const searchButton = [...activeDialog().querySelectorAll("button")].find(
    (button) => button.textContent === "対戦相手を探す",
  );
  expect(searchButton?.nextElementSibling?.textContent).toBe("戻る");
  press(activeDialog(), "戻る");
  await flush();
  expect(router.state.location.search).toBe("");
  expect(dialogs()).toHaveLength(0);
  await act(async () => {
    await router.navigate(shogiDialogUrl);
  });
  expect(requests.filter((request) => request.url === shogiRatingUrl)).toHaveLength(2);
  latest(shogiRatingUrl).respond({ message: "一時エラー" }, 503);
  await flush();
  expect(activeDialog().textContent).toContain("レートを取得できませんでした");
  press(activeDialog(), "レートを再取得する");
  await flush();
  latest(shogiRatingUrl).respond({ status: "rated", rating: 1523.6 });
  await flush();
  expect(activeDialog().textContent).toContain("1524");
});

test("ゲストには将棋のレート戦のログイン案内を表示する", async () => {
  shogiPage({ ...user, isGuest: true });
  latest(shogiStatusUrl).respond(shogiIdle());
  await flush();
  expect(activeDialog().querySelector('a[href="/login"]')).not.toBeNull();
  expect(activeDialog().textContent).not.toContain("対戦相手を探す");
  expect(latest(shogiRatingUrl)).toBeUndefined();
});

test("旧将棋マッチングURLからロビーのダイアログURLへリダイレクトする", async () => {
  const { router: appRouter } = await import("../src/app/router");
  const oldPath = "/games/shogi/matchmaking";
  const legacy = matchRoutes(appRouter.routes, oldPath)?.at(-1)?.route;
  expect(legacy?.path).toBe(oldPath);
  const router = createMemoryRouter(
    [
      {
        path: oldPath,
        loader: legacy!.loader,
        hydrateFallbackElement: legacy!.hydrateFallbackElement,
      },
      { path: shogiLobby, element: <Path /> },
    ],
    { initialEntries: [oldPath] },
  );
  render(<RouterProvider router={router} />);
  await flush();
  expect(router.state.location.pathname + router.state.location.search).toBe(shogiDialogUrl);
});

test.each(["戻る", "閉じる", "Escape", "背景クリック", "履歴を戻る"] as const)(
  "%sで取消確認を表示し、探し続けると待機を継続する",
  async (action) => {
    const router = shogiPage();
    await startShogiSearch();
    if (action === "戻る") press(activeDialog(), action);
    else if (action === "閉じる")
      act(() => activeDialog().querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
    else if (action === "Escape")
      act(() =>
        activeDialog().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
      );
    else if (action === "背景クリック")
      act(() => {
        const backdrop = activeDialog().closest(".app-modal")!;
        for (const type of ["pointerdown", "pointerup", "click"])
          backdrop.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }));
      });
    else
      await act(async () => {
        await router.navigate(-1);
      });
    await flush();
    expect(dialogs()).toHaveLength(2);
    expect(activeDialog().textContent).toContain("閉じると対戦相手を探すのをやめます");
    press(activeDialog(), "探し続ける");
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(activeDialog().textContent).toContain("対戦相手を探しています");
    expect(latest(shogiCancelUrl)).toBeUndefined();
    expect(router.state.location.search).toBe("?matchmaking=1");
  },
);

test("取消をサーバーが確定するまでは確認を表示し、失敗後に状態を確認できる", async () => {
  const router = shogiPage();
  await startShogiSearch();
  await act(async () => {
    await router.navigate(-1);
  });
  press(activeDialog(), "探すのをやめる");
  await flush();
  expect(dialogs()).toHaveLength(2);
  latest(shogiCancelUrl).respond({ message: "通信エラー" }, 503);
  await flush();
  expect(activeDialog().textContent).toContain("通信エラー");
  press(activeDialog(), "状態を確認する");
  await flush();
  latest(shogiStatusUrl).respond(shogiIdle());
  await flush();
  expect(dialogs()).toHaveLength(0);
  expect(router.state.location.search).toBe("");
});

test("待機中の取消が確定したらロビーに戻る", async () => {
  const router = shogiPage();
  await startShogiSearch();
  press(activeDialog(), "戻る");
  press(activeDialog(), "探すのをやめる");
  await flush();
  latest(shogiCancelUrl).respond(shogiIdle());
  await flush();
  expect(dialogs()).toHaveLength(0);
  expect(router.state.location.search).toBe("");
});

test.each(["cpu", "human"] as const)(
  "取消確認中に%s戦が成立すると5秒待たずに入室する",
  async (opponent) => {
    const router = shogiPage();
    const waiting = await startShogiSearch();
    await act(async () => {
      await router.navigate(-1);
    });
    await flush();
    const matched = { ...waiting, status: "matched", assignment: assignment(opponent) };
    if (opponent === "cpu") {
      clock.advance(3000);
      await flush();
      latest(shogiStatusUrl).respond(matched);
      expect(latest(shogiCancelUrl)).toBeUndefined();
    } else {
      press(activeDialog(), "探すのをやめる");
      await flush();
      latest(shogiCancelUrl).respond(matched);
    }
    await flush();
    expect(dialogs()).toHaveLength(1);
    const entry = latest(shogiStatusUrl);
    entry.respond(matched);
    await flush();
    expect(router.state.location.pathname).toBe("/rooms/12345");
    expect(router.state.location.search).toBe(`?invite=${matched.assignment.instanceId}`);
    expect(JSON.parse(sessionStorage.getItem("tetraboard:matchmaking-room:12345")!).game).toBe(
      "shogi",
    );
  },
);

test("終局後の再参加はダイアログから検索を一度だけ始める", async () => {
  shogiPage(user, true);
  latest(shogiStatusUrl).respond(shogiIdle());
  await flush();
  await respondToJoin();
  expect(activeDialog().textContent).toContain("対戦相手を探しています");
  expect(requests.filter((request) => request.url === shogiJoinUrl)).toHaveLength(1);
});
test("Web Locksがなくても明示参加でき、再読み込み用の待機とCPU補充の案内を保持する", async () => {
  const { view, controller } = page();
  latest("/api/matchmaking/four-reversi?").respond({
    status: "idle",
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("3分切れ負け");
  expect(view.textContent).toContain("CPU「ヨミ」（Lv3）");
  press(view, "対戦相手を探す");
  await flush();
  const join = latest("/join");
  expect(join).toBeDefined();
  const body = JSON.parse(String(join.init.body));
  expect(body.controllerId).toBe(controller.getIdentity());
  join.respond({
    status: "waiting",
    operationId: body.operationId,
    controllerId: body.controllerId,
    version: 1,
    joinedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30000,
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("対戦相手を探しています");
  expect(view.textContent).not.toContain("ニックネーム");
  press(view, "取り消す");
  await flush();
  const cancel = latest("/cancel");
  expect(JSON.parse(String(cancel.init.body))).toMatchObject({
    operationId: body.operationId,
    version: 1,
  });
  cancel.respond({ status: "idle", serverNowMs: Date.now(), enabled: true });
  await flush();
  expect(view.textContent).toContain("対戦相手を探す");
});
test("成立後の5秒で参加資格を保存して入室し、ポーリングで待ち時間を数え直さない", async () => {
  const { view, controller } = page();
  const operationId = crypto.randomUUID(),
    roomId = "12345",
    instanceId = crypto.randomUUID();
  const state = {
    status: "matched",
    operationId,
    controllerId: controller.getIdentity(),
    version: 1,
    joinedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 30000,
    serverNowMs: Date.now(),
    enabled: true,
    assignment: {
      matchId: crypto.randomUUID(),
      roomId,
      instanceId,
      expiresAtMs: Date.now() + 30000,
      membership: { playerId: crypto.randomUUID(), role: "host", token: "a".repeat(64) },
    },
  };
  latest("/api/matchmaking/four-reversi?").respond(state);
  await flush();
  expect(view.textContent).toContain("対戦相手が決まりました");
  clock.advance(3000);
  latest("/api/matchmaking/four-reversi?").respond({ ...state, serverNowMs: Date.now() });
  await flush();
  clock.advance(1999);
  await flush();
  expect(view.querySelector("[data-path]")).toBeNull();
  clock.advance(1);
  await flush();
  latest("/api/matchmaking/four-reversi?").respond(state);
  await flush();
  expect(view.querySelector("[data-path]")?.textContent).toBe(`/rooms/${roomId}`);
  expect(sessionStorage.getItem(`tetraboard:room:${roomId}:membership`)).toBe("a".repeat(64));
});
test("別の操作元の待機を勝手に引き継がず、ボタンから同じ待機を引き継ぐ", async () => {
  const { view } = page();
  const operationId = crypto.randomUUID();
  latest("/api/matchmaking/four-reversi?").respond({
    status: "waiting",
    operationId,
    controllerId: crypto.randomUUID(),
    version: 2,
    joinedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30000,
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("別のタブまたは端末");
  expect(view.textContent).not.toContain("マッチングを取り消す");
  expect(requests.some((r) => r.url.endsWith("/takeover"))).toBe(false);
  press(view, "このタブで続ける");
  await flush();
  const transfer = latest("/takeover");
  expect(transfer).toBeDefined();
  expect(JSON.parse(String(transfer.init.body)).operationId).toBe(operationId);
});

test("継続確認の応答待ちでも取消を送れ、遅れた応答で待機を復活させない", async () => {
  const { view, controller } = page();
  const operationId = crypto.randomUUID();
  const waiting = {
    status: "waiting",
    operationId,
    controllerId: controller.getIdentity(),
    version: 1,
    joinedAtMs: Date.now(),
    expiresAtMs: Date.now() + 30000,
    serverNowMs: Date.now(),
    enabled: true,
  };
  latest("/api/matchmaking/four-reversi?").respond(waiting);
  await flush();
  clock.advance(10000);
  await flush();
  const heartbeat = latest("/heartbeat");
  expect(heartbeat).toBeDefined();
  press(view, "取り消す");
  await flush();
  const cancel = latest("/cancel");
  expect(cancel).toBeDefined();
  cancel.respond({ status: "idle", serverNowMs: Date.now(), enabled: true });
  await flush();
  heartbeat.respond({ ...waiting, expiresAtMs: Date.now() + 30000 });
  await flush();
  expect(view.textContent).toContain("対戦相手を探す");
  expect(view.textContent).not.toContain("対戦相手を探しています");
});

test("待機時間は端末の時計のずれに影響されずサーバー時刻から表示する", async () => {
  const { view, controller } = page();
  const serverNow = Date.now() + 60000;
  latest("/api/matchmaking/four-reversi?").respond({
    status: "waiting",
    operationId: crypto.randomUUID(),
    controllerId: controller.getIdentity(),
    version: 1,
    joinedAtMs: serverNow - 10000,
    expiresAtMs: serverNow + 20000,
    serverNowMs: serverNow,
    enabled: true,
  });
  await flush();
  expect(view.textContent).toContain("待機時間：10秒");
  clock.advance(1000);
  await flush();
  expect(view.textContent).toContain("待機時間：11秒");
});

test("保存できない端末では新しい待機を送信せず、入力を保持して案内する", async () => {
  const { view } = page();
  latest("/api/matchmaking/four-reversi?").respond({
    status: "idle",
    serverNowMs: Date.now(),
    enabled: true,
  });
  await flush();
  const denied = denyStorage();
  try {
    press(view, "対戦相手を探す");
    await flush();
    expect(requests.some((r) => r.url.endsWith("/join"))).toBe(false);
    expect(view.textContent).toContain("保存");
  } finally {
    denied.mockRestore();
  }
});
