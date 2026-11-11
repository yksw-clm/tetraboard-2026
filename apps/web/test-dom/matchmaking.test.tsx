import { expect, spyOn, test } from "bun:test";
import { createMemoryRouter, matchRoutes, RouterProvider, useLocation } from "react-router";
import { legalVersion } from "@tetraboard/protocol/privacy";
import type { AccountProfile, RatedMatchmakingGame } from "@tetraboard/protocol";
import { readRegistrationReturn } from "../src/features/account/registrationReturn";
import { RatedMatchmakingDialog } from "../src/features/matchmaking/RatedMatchmakingDialog";
import {
  readMatchmakingQueue,
  saveMatchmakingQueue,
} from "../src/features/matchmaking/matchmakingStorage";
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
function shogiPage(
  viewer: AccountProfile | null = user,
  rejoin = false,
  game: RatedMatchmakingGame = "shogi",
  reload = false,
  accountState: { loading: boolean; error: string | null } = { loading: false, error: null },
) {
  const lobby = `/games/${game}`;
  const locks = {
    request: (name: string, _options: LockOptions, callback: (lock: Lock) => Promise<void>) =>
      callback({ name, mode: "exclusive" }),
  } as LockManager;
  const controller = new QueueDocumentController({
    isReload: () => reload,
    locks: () => (reload ? locks : undefined),
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
        ...accountState,
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

test.each([
  { game: "four-shogi", count: 12, next: 9 },
  { game: "four-reversi", count: 12, next: 9 },
  { game: "shogi", count: 4, next: 3 },
  { game: "reversi", count: 4, next: 3 },
] as const)(
  "$gameの待機人数はCPU枠を含む合計だけを表示し、省略時に隠して次の更新で回復する",
  async ({ game, count, next }) => {
    shogiPage(user, false, game);
    const statusUrl = `/api/matchmaking/${game}?`;
    const status = latest(statusUrl);
    expect(status.url).toContain("waitingCount=1");
    status.respond({ ...shogiIdle(), waitingCount: count });
    latest(`/api/matchmaking/${game}/rating`).respond({ status: "placement", games: 0 });
    await flush();
    expect(activeDialog().textContent).toContain(`${count}人が待機中`);
    expect(activeDialog().textContent).not.toContain("混み合っています");
    expect(activeDialog().textContent).not.toContain("CPUを含む");
    clock.advance(3000);
    await flush();
    latest(statusUrl).respond(shogiIdle());
    await flush();
    expect(activeDialog().textContent).not.toContain("人が待機中");
    clock.advance(3000);
    await flush();
    latest(statusUrl).respond({ ...shogiIdle(), waitingCount: next });
    await flush();
    expect(activeDialog().textContent).toContain(`${next}人が待機中`);
  },
);

test.each([
  { game: "four-shogi", seconds: 20 },
  { game: "four-reversi", seconds: 20 },
  { game: "shogi", seconds: 15 },
  { game: "reversi", seconds: 15 },
] as const)(
  "$gameは検索中だけ目安を表示し、成立時に入室案内へ切り替える",
  async ({ game, seconds }) => {
    shogiPage(user, false, game);
    const statusUrl = `/api/matchmaking/${game}?`;
    expect(latest(statusUrl).url).toContain("estimate=1");
    latest(statusUrl).respond(shogiIdle());
    latest(`/api/matchmaking/${game}/rating`).respond({ status: "placement", games: 0 });
    await flush();
    expect(activeDialog().textContent).not.toContain("マッチングの目安");
    press(activeDialog(), "対戦相手を探す");
    await flush();
    const join = latest(`/api/matchmaking/${game}/join`);
    expect(join.url).toContain("estimate=1");
    const waiting = {
      ...shogiIdle(),
      ...JSON.parse(String(join.init.body)),
      status: "waiting",
      version: 1,
      joinedAtMs: Date.now(),
      estimatedMatchAtMs: Date.now() + seconds * 1000,
    };
    join.respond(waiting);
    await flush();
    expect(activeDialog().textContent).toContain(`マッチングの目安：あと約${seconds}秒`);
    clock.advance(3000);
    await flush();
    latest(statusUrl).respond({
      ...waiting,
      status: "matched",
      serverNowMs: Date.now(),
      assignment: assignment("human"),
    });
    await flush();
    expect(activeDialog().textContent).not.toContain("マッチングの目安");
    expect(activeDialog().textContent).not.toContain("待機時間：");
    expect(activeDialog().textContent).toContain("対戦相手が決まりました。");
  },
);

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

const ratedGames: RatedMatchmakingGame[] = ["shogi", "reversi", "four-shogi", "four-reversi"];
test.each(ratedGames)(
  "未ログインとゲストに連携のメリットと認証ボタンを表示する %s",
  async (game) => {
    for (const viewer of [null, { ...user, isGuest: true }]) {
      const router = shogiPage(viewer, false, game);
      latest(`/api/matchmaking/${game}?`).respond({ ...shogiIdle(), waitingCount: 4 });
      await flush();
      const dialog = activeDialog();
      expect(dialog.textContent).toContain("アカウントを連携して、レート戦に挑戦！");
      expect(dialog.textContent).toContain("対局でレートを上げて、ランキング上位を目指そう！");
      expect(dialog.textContent).toContain("レートのイメージ");
      expect(dialog.textContent).toContain("1500");
      expect(dialog.textContent).not.toContain("人が待機中");
      expect(dialog.textContent).not.toContain("対戦相手を探す");
      expect(dialog.querySelector('a[href="/login"]')).toBeNull();
      for (const provider of ["Google", "Discord"])
        expect(
          [...dialog.querySelectorAll("button")].some(
            (b) => b.textContent === `${provider}で続ける`,
          ),
        ).toBe(true);
      expect(dialog.querySelector('a[href="/terms"]')?.getAttribute("target")).toBe("_blank");
      expect(dialog.querySelector('a[href="/privacy"]')).not.toBeNull();
      expect(dialog.textContent).toContain("利用規約");
      expect(latest(`/api/matchmaking/${game}/rating`)).toBeUndefined();
      expect(latest(`/api/matchmaking/${game}/join`)).toBeUndefined();
      press(dialog, "戻る");
      await flush();
      expect(router.state.location.search).toBe("");
    }
  },
);

test.each(["google", "discord"] as const)(
  "認証開始中の操作を防ぎ、失敗後に再試行できる %s",
  async (provider) => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      const router = shogiPage(null);
      latest(shogiStatusUrl).respond(shogiIdle());
      await flush();
      const dialog = activeDialog();
      const label = `${provider === "google" ? "Google" : "Discord"}で続ける`;
      press(dialog, label);
      press(dialog, label);
      await flush();
      const oauth = () => requests.filter((r) => r.url === "/api/auth/sign-in/social");
      expect(oauth()).toHaveLength(1);
      expect(JSON.parse(String(oauth()[0]!.init.body))).toEqual({
        provider,
        analytics: { id: expect.any(String), entry: "rated-match", game: "shogi" },
      });
      expect(new Headers(oauth()[0]!.init.headers).get("X-Legal-Consent")).toBe(legalVersion);
      expect(readRegistrationReturn()).toMatchObject({ path: shogiDialogUrl, oauthStarted: true });
      for (const button of dialog.querySelectorAll("button")) expect(button.disabled).toBe(true);
      const processing = dialog.querySelectorAll('button:has([data-slot="pending-spinner"])');
      expect(processing).toHaveLength(1);
      expect(processing[0]!.textContent).toContain(label);
      act(() =>
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      await act(async () => {
        await router.navigate(-1);
      });
      expect(router.state.location.search).toBe("?matchmaking=1");
      oauth()[0]!.respond({ message: "接続できませんでした" }, 503);
      await flush();
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("接続できませんでした");
      expect(readRegistrationReturn()?.oauthStarted).toBe(false);
      for (const button of dialog.querySelectorAll("button")) expect(button.disabled).toBe(false);
      press(dialog, label);
      await flush();
      const url =
        provider === "google"
          ? "https://accounts.google.com/o/oauth2/auth"
          : "https://discord.com/oauth2/authorize";
      oauth()[1]!.respond({ url });
      await flush();
      expect(assign).toHaveBeenCalledWith(url);
      expect(latest(shogiJoinUrl)).toBeUndefined();
    } finally {
      assign.mockRestore();
    }
  },
);

test.each([
  { loading: true, error: null },
  { loading: false, error: "ログイン状態を確認できません。" },
])("認証の確認中・取得失敗を未ログインの連携案内にしない %o", async (accountState) => {
  shogiPage(null, false, "shogi", false, accountState);
  if (latest(shogiStatusUrl)) latest(shogiStatusUrl).respond(shogiIdle());
  await flush();
  expect(activeDialog().textContent).not.toContain("Googleで続ける");
  expect(activeDialog().textContent).not.toContain("レート戦に挑戦！");
  if (accountState.error) expect(activeDialog().textContent).toContain(accountState.error);
});

test("受付停止中は準備中を表示し、連携へ誘導しない", async () => {
  shogiPage(null);
  latest(shogiStatusUrl).respond({ ...shogiIdle(), enabled: false });
  await flush();
  expect(activeDialog().textContent).toContain("将棋のレート戦は準備中です。");
  expect(activeDialog().textContent).not.toContain("Googleで続ける");
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

test.each(["shogi", "four-reversi", "four-shogi", "reversi"] as const)(
  "%sは前局の待機情報が残っていても新しい操作IDで再検索を一度だけ始める",
  async (game) => {
    const previous = {
      operationId: crypto.randomUUID(),
      controllerId: crypto.randomUUID(),
      version: 1,
    };
    saveMatchmakingQueue(identity, previous, game);
    const router = shogiPage(user, true, game);
    const joins = () => requests.filter(({ url }) => url.includes(`/api/matchmaking/${game}/join`));
    const clearedIntent = new Set<number>();
    const unsubscribe = router.subscribe(({ location }) => {
      if (location.state === null) clearedIntent.add(joins().length);
    });
    latest(`/api/matchmaking/${game}?`).respond(shogiIdle());
    await flush();
    unsubscribe();
    expect([...clearedIntent]).toEqual([1]);
    const join = joins()[0]!;
    const input = JSON.parse(String(join.init.body));
    expect(input.operationId).not.toBe(previous.operationId);
    expect(router.state.location.state).toBeNull();
    expect(activeDialog().textContent).not.toContain("待機が終了しました");
    join.respond({
      ...shogiIdle(),
      ...input,
      status: "waiting",
      version: 1,
      joinedAtMs: Date.now(),
    });
    await flush();
    expect(activeDialog().textContent).toContain("対戦相手を探しています");
    expect(joins()).toHaveLength(1);
  },
);

test.each([true, false])("待機中は既存の操作を復元・引き継ぐ reload=%s", async (reload) => {
  const previous = {
    operationId: crypto.randomUUID(),
    controllerId: crypto.randomUUID(),
    version: 1,
  };
  saveMatchmakingQueue(identity, previous, "shogi");
  shogiPage(user, false, "shogi", reload);
  const waiting = { ...shogiIdle(), ...previous, status: "waiting", joinedAtMs: Date.now() };
  latest(shogiStatusUrl).respond(waiting);
  await flush();
  const takeoverUrl = "/api/matchmaking/shogi/takeover";
  if (!reload) {
    expect(latest(takeoverUrl)).toBeUndefined();
    press(activeDialog(), "このタブで続ける");
    await flush();
  }
  const takeover = latest(takeoverUrl);
  const input = JSON.parse(String(takeover.init.body));
  expect(input.operationId).toBe(previous.operationId);
  takeover.respond({ ...waiting, controllerId: input.controllerId, version: 2 });
  await flush();
  expect(activeDialog().textContent).toContain("対戦相手を探しています");
  expect(activeDialog().textContent).not.toContain("待機が終了しました");
  expect(latest(shogiJoinUrl)).toBeUndefined();
});

test("前局の情報が残っていてもロビーから開くだけなら終了案内も検索も発生しない", async () => {
  saveMatchmakingQueue(
    identity,
    { operationId: crypto.randomUUID(), controllerId: crypto.randomUUID(), version: 1 },
    "shogi",
  );
  shogiPage();
  latest(shogiStatusUrl).respond(shogiIdle());
  await flush();
  expect(activeDialog().textContent).not.toContain("待機が終了しました");
  expect(activeDialog().textContent).toContain("対戦相手を探す");
  expect(latest(shogiJoinUrl)).toBeUndefined();
  expect(readMatchmakingQueue(identity, "shogi")).toBeNull();
});

test("確認済みの待機が終了した場合は案内を表示し、自動で検索し直さない", async () => {
  shogiPage();
  await startShogiSearch();
  clock.advance(3000);
  latest(shogiStatusUrl).respond(shogiIdle());
  await flush();
  expect(activeDialog().textContent).toContain("待機が終了しました");
  expect(requests.filter(({ url }) => url.includes(shogiJoinUrl))).toHaveLength(1);
});

test("再検索の通信に失敗しても自動で送り直さず、明示的な再試行で同じ操作IDを使う", async () => {
  shogiPage(user, true);
  latest(shogiStatusUrl).respond(shogiIdle());
  await flush();
  const first = latest(shogiJoinUrl);
  first.respond({ message: "通信エラー" }, 503);
  await flush();
  expect(activeDialog().textContent).toContain("通信エラー");
  expect(requests.filter(({ url }) => url.includes(shogiJoinUrl))).toHaveLength(1);
  press(activeDialog(), "対戦相手を探す");
  await flush();
  expect(latest(shogiJoinUrl)).not.toBe(first);
  expect(latest(shogiJoinUrl).init.body).toBe(first.init.body);
  await respondToJoin();
});
const fourStatus = "/api/matchmaking/four-reversi?";

test("四人リバーシで旧応答のランクを表示せず、再参加からCPU戦へすぐ入室する", async () => {
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
  expect(activeDialog().textContent).not.toContain("対人戦未経験");
  expect(activeDialog().textContent).not.toContain("シルバー2");
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

test("通常リバーシの認定進捗を表示し、専用キューのCPU割当で入室する", async () => {
  const router = shogiPage(user, false, "reversi");
  latest("/api/matchmaking/reversi?").respond(shogiIdle());
  latest("/api/matchmaking/reversi/rating").respond({ status: "placement", games: 2 });
  await flush();
  expect(activeDialog().textContent).toContain("2 / 5");
  press(activeDialog(), "対戦相手を探す");
  await flush();
  const join = latest("/api/matchmaking/reversi/join");
  const operation = JSON.parse(String(join.init.body));
  const matched = {
    ...shogiIdle(),
    ...operation,
    status: "matched",
    version: 1,
    assignment: assignment("cpu"),
  };
  join.respond(matched);
  await flush();
  latest("/api/matchmaking/reversi?").respond(matched);
  await flush();
  expect(router.state.location.pathname).toBe("/rooms/12345");
  expect(JSON.parse(sessionStorage.getItem("tetraboard:matchmaking-room:12345")!).game).toBe(
    "reversi",
  );
});
