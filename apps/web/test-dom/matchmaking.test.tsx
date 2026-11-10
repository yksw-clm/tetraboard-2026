import { expect, test } from "bun:test";
import { createMemoryRouter, matchRoutes, RouterProvider, useLocation } from "react-router";
import { RatedMatchmakingDialog } from "../src/features/matchmaking/RatedMatchmakingDialog";
import { AccountContext } from "../src/features/account/useAccount";
import {
  QueueControllerContext,
  QueueDocumentController,
} from "../src/shared/QueueDocumentController";
import { profile } from "../test/fixtures/account";
import { act, clock, flush, press, render, requests, denyStorage } from "./harness";
const identity = "00000000-0000-4000-8000-000000000001";
const user = { ...profile, profileId: identity };
function Path() {
  const location = useLocation();
  return <p data-path>{location.pathname}</p>;
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
function shogiPage(viewer = user, rejoin = false, game: "shogi" | "four-reversi" = "shogi") {
  const lobby = `/games/${game}`;
  const controller = new QueueDocumentController({
    isReload: () => false,
    locks: () => undefined,
    channel: () => null,
  });
  function Lobby() {
    const { search } = useLocation();
    return search === "?matchmaking=1" ? <RatedMatchmakingDialog game={game} /> : null;
  }
  const router = createMemoryRouter(
    [
      { path: lobby, element: <Lobby /> },
      { path: "*", element: <Path /> },
    ],
    {
      initialEntries: [
        lobby,
        {
          pathname: lobby,
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

test.each(["shogi", "four-reversi"])(
  "旧マッチングURLからロビーのダイアログURLへリダイレクトする %s",
  async (game) => {
    const { router: appRouter } = await import("../src/app/router");
    const lobby = `/games/${game}`;
    const oldPath = `${lobby}/matchmaking`;
    const legacy = matchRoutes(appRouter.routes, oldPath)?.at(-1)?.route;
    expect(legacy?.path).toBe(oldPath);
    const router = createMemoryRouter(
      [
        {
          path: oldPath,
          loader: legacy!.loader,
          hydrateFallbackElement: legacy!.hydrateFallbackElement,
        },
        { path: lobby, element: <Path /> },
      ],
      { initialEntries: [oldPath] },
    );
    render(<RouterProvider router={router} />);
    await flush();
    expect(router.state.location.pathname + router.state.location.search).toBe(
      `${lobby}?matchmaking=1`,
    );
  },
);

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
const fourStatus = "/api/matchmaking/four-reversi?";

test("四人リバーシでランクを表示し、再参加から検索してCPU戦へすぐ入室する", async () => {
  const router = shogiPage(user, true, "four-reversi");
  expect(latest(fourStatus).url).toContain("rated=1");
  latest(fourStatus).respond(shogiIdle());
  latest("/api/matchmaking/four-reversi/rating").respond({
    status: "rated",
    rating: 1512,
    rank: "シルバー2",
    humanPlayed: false,
  });
  await flush();
  expect(activeDialog().textContent).toContain("四人リバーシのレート戦");
  expect(activeDialog().textContent).toContain("1512");
  expect(activeDialog().textContent).toContain("シルバー2（対人戦未経験）");
  const join = latest("/api/matchmaking/four-reversi/join?rated=1");
  const matched = {
    ...shogiIdle(),
    ...JSON.parse(String(join.init.body)),
    status: "matched",
    version: 1,
    assignment: assignment("cpu"),
  };
  join.respond(matched);
  await flush();
  latest(fourStatus).respond(matched);
  await flush();
  expect(router.state.location.pathname).toBe("/rooms/12345");
  expect(JSON.parse(sessionStorage.getItem("tetraboard:matchmaking-room:12345")!).game).toBe(
    "four-reversi",
  );
});

test.each([false, true])(
  "切り替え前に成立した四人リバーシは旧列から入室できる guest=%s",
  async (isGuest) => {
    const operationId = crypto.randomUUID();
    sessionStorage.setItem(
      `tetraboard:matchmaking:${identity}`,
      JSON.stringify({
        operationId,
        controllerId: crypto.randomUUID(),
        version: 1,
      }),
    );
    const router = shogiPage({ ...user, isGuest }, false, "four-reversi");
    const controllerId = new URL(latest(fourStatus).url, "https://example.test").searchParams.get(
      "controllerId",
    );
    latest(fourStatus).respond(shogiIdle());
    await flush();
    expect(latest(fourStatus).url).not.toContain("rated=1");
    const matched = {
      ...shogiIdle(),
      enabled: false,
      status: "matched",
      operationId,
      controllerId,
      version: 1,
      assignment: assignment("human"),
    };
    latest(fourStatus).respond(matched);
    await flush();
    latest(fourStatus).respond(matched);
    await flush();
    expect(router.state.location.pathname).toBe("/rooms/12345");
    expect(
      JSON.parse(sessionStorage.getItem("tetraboard:matchmaking-room:12345")!).game,
    ).toBeUndefined();
  },
);

test("保存できない端末では四人リバーシの待機を送信しない", async () => {
  shogiPage(user, false, "four-reversi");
  latest(fourStatus).respond(shogiIdle());
  latest("/api/matchmaking/four-reversi/rating").respond({ status: "placement", games: 0 });
  await flush();
  const denied = denyStorage();
  try {
    press(activeDialog(), "対戦相手を探す");
    await flush();
    expect(latest("/join")).toBeUndefined();
    expect(activeDialog().textContent).toContain("保存");
  } finally {
    denied.mockRestore();
  }
});
