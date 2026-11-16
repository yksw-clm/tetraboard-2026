import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router";
import { fourReversiRoomSchema, isFourReversiRoom } from "@tetraboard/protocol";
import RoomDetail from "../src/features/room/FourReversiRoomDetail";
import ShogiRoomDetail from "../src/features/room/FourShogiRoomDetail";
import StandardShogiRoomDetail from "../src/features/room/ShogiRoomDetail";
import { RoomErrorPage } from "../src/features/room/RoomPage";
import { roomLoader } from "../src/features/room/roomLoader";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { issueViewerToken } from "../src/features/room/roomApi";
import { fetchFourShogiReplay } from "../src/features/room/fourShogiReplay";
import { fetchShogiReplay } from "../src/features/room/standardShogiReplay";
import { readRatingResult } from "../src/features/matchmaking/matchmakingApi";
import { useRatingResult } from "../src/features/matchmaking/useRatingResult";
import { PlayerProfileStore, profileKey } from "../src/features/players/playerProfileStore";
import { createPreloadRecovery, preloadRecovery } from "../src/shared/preloadRecovery";
import { roomReloadMessage } from "../src/shared/roomResponseValidation";
import * as clientErrors from "../src/shared/clientErrors";
import { readRoomMembershipToken, saveRoomMembershipToken } from "../src/shared/roomMembership";
import { membership, now, playerIds, token, waitingRoom } from "../test/fixtures/rooms";
import { finishedShogiRound, waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { standardPlayingRoom, standardSavedRound } from "../test/fixtures/standardShogiFixtures";
import {
  act,
  clock,
  denyStorage,
  flush,
  press,
  render,
  renderHook,
  requests,
  wrap,
} from "./harness";
import { installSocket, Socket } from "./socket";

const reload = mock(() => {});
const report = mock((_kind: string, _message: string) => {});
const restores: (() => void)[] = [];
function nextDocument() {
  const recovery = createPreloadRecovery({ reload });
  const spy = spyOn(preloadRecovery, "tryAutoReload").mockImplementation(recovery.tryAutoReload);
  restores.push(() => spy.mockRestore());
}
beforeEach(() => {
  reload.mockClear();
  report.mockClear();
  restores.push(installSocket());
  nextDocument();
  const manual = spyOn(preloadRecovery, "reload").mockImplementation(reload);
  const reporting = spyOn(clientErrors, "reportClientError").mockImplementation(report);
  restores.push(
    () => manual.mockRestore(),
    () => reporting.mockRestore(),
  );
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

function options(room = waitingRoom()) {
  saveRoomMembershipToken(room.id, token);
  return {
    initialRoom: room,
    initialMembership: membership,
    initialServerNowMs: now,
    initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
  };
}
function connect(room = waitingRoom()) {
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive({ type: "room.authenticated", membership });
  return socket;
}
function badSnapshot(socket: Socket) {
  socket.receive({ type: "room.snapshot", privateBody: "SECRET" });
}
function assertStopped(socket: Socket) {
  const count = requests.length;
  const connections = Socket.instances.length;
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    socket.onclose?.();
    socket.onerror?.();
  });
  clock.advance(60000);
  expect(requests).toHaveLength(count);
  expect(Socket.instances).toHaveLength(connections);
  expect(socket.readyState).toBe(3);
}

test("WebSocketの検証失敗は文書をまたいで一度だけ更新し、資格を保持して再接続を止める", async () => {
  const first = renderHook(useRoomSession, options(), wrap());
  const socket = connect();
  act(() => first.current.handleReadyClick());
  badSnapshot(socket);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(first.current.authenticated).toBe(false);
  expect(first.current.pendingReady).toBeNull();
  expect(readRoomMembershipToken(waitingRoom().id)).toBe(token);
  assertStopped(socket);
  first.unmount();

  nextDocument();
  const view = render(wrap()(<RoomDetail {...options()} invited={false} />));
  const second = connect();
  badSnapshot(second);
  await flush();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(view.querySelector('[role="alert"]')?.textContent).toContain(roomReloadMessage);
  expect(view.querySelector('[aria-label="四人リバーシの盤面"]')).not.toBeNull();
  expect(report.mock.calls).toEqual([
    ["RoomResponseValidationError", "room.snapshot"],
    ["RoomResponseValidationError", "room.snapshot"],
  ]);
  assertStopped(second);
  press(view, "再読み込み");
  expect(reload).toHaveBeenCalledTimes(2);
});

test("preload失敗後の検証失敗は自動更新を増やさない", async () => {
  preloadRecovery.tryAutoReload();
  expect(reload).toHaveBeenCalledTimes(1);
  nextDocument();
  const view = render(wrap()(<RoomDetail {...options()} invited={false} />));
  badSnapshot(connect());
  await flush();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(view.textContent).toContain(roomReloadMessage);
});

test.each(
  ["rated", "matchmaking", "tournament"].flatMap((kind) =>
    ["used", "denied"].map((storage) => ({ kind, storage })),
  ),
)(
  "$kind: 開始予告中の検証失敗では重ね表示を消す（自動更新: $storage ）",
  async ({ kind, storage }) => {
    if (storage === "used") {
      preloadRecovery.tryAutoReload();
      nextDocument();
      reload.mockClear();
    }
    const base = waitingRoom();
    const room = fourReversiRoomSchema.parse({
      ...base,
      settings: { ...base.settings, timeControl: { mainTimeMs: 180000, byoyomiMs: 0 } },
      ...(kind === "tournament"
        ? { tournamentId: 1, tournamentStartsAtMs: now + 5000 }
        : {
            matchmaking: {
              id: base.instanceId,
              preparedAtMs: now,
              startsAtMs: now + 5000,
              ...(kind === "rated" ? { rated: true } : {}),
            },
          }),
    });
    saveRoomMembershipToken(room.id, token);
    const view = render(
      wrap()(
        <RoomDetail
          initialRoom={room}
          initialMembership={membership}
          initialServerNowMs={now}
          initialPresence={options().initialPresence}
          invited={false}
        />,
      ),
    );
    const socket = Socket.instances.at(-1)!;
    socket.open();
    socket.snapshot(room);
    socket.receive({ type: "room.authenticated", membership });
    await flush();
    const label =
      kind === "tournament" ? "大会対局の開始カウントダウン" : "対局の開始カウントダウン";
    expect(view.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    const denied = storage === "denied" ? denyStorage() : null;
    try {
      badSnapshot(socket);
      await flush();
      expect(view.querySelector(`[aria-label="${label}"]`)).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const notice = view.querySelector<HTMLElement>('[role="alert"]')!;
      expect(notice.textContent).toContain(roomReloadMessage);
      expect(notice.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(notice.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      press(notice, "再読み込み");
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      denied?.mockRestore();
    }
  },
);

test.each(["settings", "declaration", "browser-settings"])(
  "%sのダイアログも検証失敗時に消して帯の操作を妨げない",
  async (dialog) => {
    preloadRecovery.tryAutoReload();
    nextDocument();
    reload.mockClear();
    const room = dialog === "declaration" ? standardPlayingRoom() : waitingRoom();
    saveRoomMembershipToken(room.id, token);
    const common = {
      initialMembership: membership,
      initialServerNowMs: now,
      initialPresence: options().initialPresence,
      invited: false,
    };
    const view = render(
      wrap()(
        isFourReversiRoom(room) ? (
          <RoomDetail {...common} initialRoom={room} />
        ) : (
          <StandardShogiRoomDetail {...common} initialRoom={room} />
        ),
      ),
    );
    const socket = Socket.instances.at(-1)!;
    socket.open();
    socket.snapshot(room);
    socket.receive({ type: "room.authenticated", membership });
    await flush();
    if (dialog === "browser-settings") {
      act(() => view.querySelector<HTMLElement>('[role="tab"][id$="-room"]')?.click());
      await flush();
      act(() =>
        view.querySelector<HTMLButtonElement>('[aria-label="表示・サウンド設定"]')!.click(),
      );
    } else press(view, dialog === "settings" ? "ルーム設定" : "入玉宣言");
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    badSnapshot(socket);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      view.querySelector('[role="alert"]')?.closest('[inert], [aria-hidden="true"]'),
    ).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    const reloadButton = view.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    act(() => reloadButton.focus());
    clock.advance(32);
    await flush();
    expect(document.activeElement).toBe(reloadButton);
    if (dialog === "browser-settings") {
      const settingsButton = view.querySelector<HTMLButtonElement>(
        '[aria-label="表示・サウンド設定"]',
      )!;
      expect(settingsButton.disabled).toBe(true);
      act(() => settingsButton.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
    press(view, "再読み込み");
    expect(reload).toHaveBeenCalledTimes(1);
  },
);

test.each(["read", "write"])(
  "sessionStorageの%s失敗なら将棋でも即座に帯を出す",
  async (failure) => {
    const room = waitingShogiRoom();
    saveRoomMembershipToken(room.id, token);
    const view = render(
      wrap()(
        <ShogiRoomDetail
          initialRoom={room}
          initialMembership={membership}
          initialServerNowMs={now}
          initialPresence={{ hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds }}
          invited={false}
        />,
      ),
    );
    const socket = Socket.instances.at(-1)!;
    socket.open();
    socket.snapshot(room);
    socket.receive({ type: "room.authenticated", membership });
    const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
    const denied =
      failure === "write"
        ? denyStorage()
        : {
            mockRestore: () => Object.defineProperty(window, "sessionStorage", descriptor),
          };
    if (failure === "read")
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get() {
          throw new Error("denied");
        },
      });
    try {
      badSnapshot(socket);
      await flush();
      expect(reload).not.toHaveBeenCalled();
      expect(view.textContent).toContain(roomReloadMessage);
      expect(view.querySelector('[aria-label="四人将棋の盤面"]')).not.toBeNull();
      assertStopped(socket);
      press(view, "再読み込み");
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      denied.mockRestore();
    }
  },
);

test("JSONとして読めない通知は自動更新せず、従来の再取得と再接続へ進む", async () => {
  const h = renderHook(useRoomSession, options(), wrap());
  const socket = connect();
  act(() => socket.onmessage?.({ data: "{" }));
  expect(h.current.reloadRequired).toBe(false);
  expect(h.current.connection).toBe("再接続中");
  expect(reload).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  clock.advance(1000);
  requests[0]!.respond({
    room: waitingRoom(),
    presence: options().initialPresence,
    serverNowMs: now,
  });
  await flush();
  requests[1]!.respond(membership);
  await flush();
  connect();
  expect(h.current.authenticated).toBe(true);
  expect(Socket.instances).toHaveLength(2);
});

for (const endpoint of ["room", "membership"] as const) {
  test(`${endpoint}のHTTP検証失敗も1回目は更新し、次の文書では帯を出す`, async () => {
    for (const attempt of [0, 1]) {
      const h = renderHook(useRoomSession, options(), wrap());
      const socket = connect();
      act(() => socket.close());
      clock.advance(1000);
      if (endpoint === "membership") {
        requests
          .at(-1)!
          .respond({ room: waitingRoom(), presence: options().initialPresence, serverNowMs: now });
        await flush();
      }
      requests.at(-1)!.respond({ privateBody: "SECRET" });
      await flush();
      expect(h.current.reloadRequired).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(report.mock.calls.at(-1)).toEqual([
        "RoomResponseValidationError",
        endpoint === "room" ? "room.get" : "room.membership",
      ]);
      assertStopped(socket);
      h.unmount();
      if (attempt === 0) nextDocument();
    }
  });
}

test("停止後のeffect再実行でも再接続せず、古いHTTPの検証失敗は無視する", async () => {
  const input = options();
  const h = renderHook(useRoomSession, input, wrap());
  const socket = connect();
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const stale = requests.at(-1)!;
  badSnapshot(socket);
  expect(stale.init.signal?.aborted).toBe(true);
  h.rerender({ ...input, initialMembership: { ...membership } });
  stale.respond({ privateBody: "SECRET" });
  await flush();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledTimes(1);
  assertStopped(socket);
});

test.each([400, 503])("HTTP %sの応答は検証失敗に置き換えず従来どおり再試行する", async (status) => {
  const h = renderHook(useRoomSession, options(), wrap());
  act(() => connect().close());
  clock.advance(1000);
  requests[0]!.respond({ error: "internal_error" }, status);
  await flush();
  expect(h.current.reloadRequired).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  clock.advance(2000);
  expect(requests).toHaveLength(2);
});

test.each(["room", "membership"])(
  "初回loaderの%s検証失敗でも共通の再読み込み案内を出す",
  async (endpoint) => {
    saveRoomMembershipToken(waitingRoom().id, token);
    const router = createMemoryRouter(
      [
        {
          path: "/rooms/:id",
          loader: roomLoader,
          ErrorBoundary: RoomErrorPage,
          element: <p>room</p>,
          HydrateFallback: () => <p>loading</p>,
        },
      ],
      { initialEntries: ["/rooms/12345"] },
    );
    const view = render(<RouterProvider router={router} />);
    if (endpoint === "membership") {
      requests
        .at(-1)!
        .respond({ room: waitingRoom(), presence: options().initialPresence, serverNowMs: now });
      await flush();
    }
    requests.at(-1)!.respond({ privateBody: "SECRET" });
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(view.textContent).toContain(roomReloadMessage);
    press(view, "再読み込み");
    expect(reload).toHaveBeenCalledTimes(2);
  },
);

test("不明な通知のtypeや本文はエラー送信へ含めない", () => {
  renderHook(useRoomSession, options(), wrap());
  connect().receive({ type: "SECRET", text: "個人情報", token: "SECRET" });
  expect(report.mock.calls).toEqual([["RoomResponseValidationError", "room.unknown"]]);
});

test("HTTP応答がJSONとして読めない場合も自動更新せず再試行する", async () => {
  const h = renderHook(useRoomSession, options(), wrap());
  const socket = connect();
  const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{"));
  try {
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(h.current.reloadRequired).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
  } finally {
    fetch.mockRestore();
  }
  clock.advance(1000);
  expect(requests).toHaveLength(1);
});

test.each(["invalid-json", "body-timeout"])(
  "レート結果の%sは接続を止めず取得エラーと再試行にする",
  async (failure) => {
    const timeout = new AbortController();
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    let requestSignal: AbortSignal | null | undefined;
    let response: Response;
    const fetch = spyOn(globalThis, "fetch").mockImplementationOnce((async (_path, init) => {
      requestSignal = init?.signal;
      response =
        failure === "invalid-json"
          ? new Response("{")
          : new Response(
              new ReadableStream({
                start(controller) {
                  requestSignal!.addEventListener(
                    "abort",
                    () => controller.error(requestSignal!.reason),
                    { once: true },
                  );
                },
              }),
            );
      return response;
    }) as typeof globalThis.fetch);
    restores.push(
      () => timeoutSpy.mockRestore(),
      () => fetch.mockRestore(),
    );
    const h = renderHook(
      (input: ReturnType<typeof options>) => ({
        session: useRoomSession(input),
        rating: useRatingResult("four-reversi", "match", membership.playerId),
      }),
      options(),
      wrap(),
    );
    const socket = connect();
    await flush();
    if (failure === "body-timeout") {
      expect(response!.bodyUsed).toBe(true);
      expect(requestSignal?.aborted).toBe(false);
      act(() => timeout.abort(new DOMException("Body timed out", "TimeoutError")));
      await flush();
      expect(requestSignal?.aborted).toBe(true);
    }
    expect(h.current.rating.failed).toBe(true);
    expect(h.current.session.reloadRequired).toBe(false);
    expect(h.current.session.authenticated).toBe(true);
    expect(socket.readyState).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    timeoutSpy.mockRestore();
    act(() => h.current.rating.retry());
    expect(requests.at(-1)!.url).toContain("/results/match?");
    expect(requests.at(-1)!.init.signal?.aborted).toBe(false);
    requests.at(-1)!.respond({ status: "excluded", reason: "unavailable" });
    await flush();
    expect(h.current.rating.failed).toBe(false);
    expect(h.current.rating.result).toEqual({ status: "excluded", reason: "unavailable" });
    expect(h.current.session.reloadRequired).toBe(false);
  },
);

test("JSONのnullはレート結果のスキーマ不一致として案内する", async () => {
  const h = renderHook(useRoomSession, options(), wrap());
  const socket = connect();
  const pending = readRatingResult("four-reversi", "match", new AbortController().signal).catch(
    () => {},
  );
  requests.at(-1)!.respond(null);
  await flush();
  await pending;
  expect(h.current.reloadRequired).toBe(true);
  expect(socket.readyState).toBe(3);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(report.mock.calls).toEqual([["RoomResponseValidationError", "rating.result"]]);
});

test.each(["invalid-json", "body-error"])(
  "プロフィールの%sも検証失敗にせず取得エラーにする",
  async (failure) => {
    const h = renderHook(useRoomSession, options(), wrap());
    const socket = connect();
    const error = new DOMException("Body timed out", "TimeoutError");
    const response =
      failure === "invalid-json"
        ? new Response("{")
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.error(error);
              },
            }),
          );
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    restores.push(() => fetch.mockRestore());
    const store = new PlayerProfileStore();
    const target = {
      source: "room" as const,
      roomId: waitingRoom().id,
      instanceId: waitingRoom().instanceId,
      playerId: membership.playerId,
    };
    await store.load(target, "four-reversi");
    expect(store.get(profileKey(target, "four-reversi")).error).not.toBeNull();
    expect(h.current.reloadRequired).toBe(false);
    expect(h.current.authenticated).toBe(true);
    expect(socket.readyState).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  },
);

test.each(["viewer", "profile", "rating", "four-shogi-replay", "shogi-replay"])(
  "%sの取得も検証失敗だけをルームの再読み込みへ渡す",
  async (endpoint) => {
    const h = renderHook(useRoomSession, options(), wrap());
    const socket = connect();
    const signal = new AbortController().signal;
    let pending: Promise<unknown>;
    if (endpoint === "viewer") pending = issueViewerToken(waitingRoom().id);
    else if (endpoint === "profile")
      pending = new PlayerProfileStore().load(
        {
          source: "room",
          roomId: waitingRoom().id,
          instanceId: waitingRoom().instanceId,
          playerId: membership.playerId,
        },
        "four-reversi",
      );
    else if (endpoint === "rating") pending = readRatingResult("four-reversi", "match", signal);
    else if (endpoint === "four-shogi-replay") {
      const room = finishedShogiRound().room;
      pending = fetchFourShogiReplay({
        roomId: room.id,
        instanceId: room.instanceId,
        lastRound: room.lastRound!,
        signal,
      });
    } else {
      const { match } = standardSavedRound();
      pending = fetchShogiReplay({
        roomId: waitingRoom().id,
        instanceId: waitingRoom().instanceId,
        signal,
        lastRound: {
          roundId: match.id,
          game: match.game,
          eventCount: match.replay.eventCount,
          players: match.participants.map(({ id, name, side }) => ({ id, name, side })),
        },
      });
    }
    const settled = pending.catch(() => {});
    requests.at(-1)!.respond({ privateBody: "SECRET" });
    await flush();
    await settled;
    expect(h.current.reloadRequired).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(report.mock.calls.at(-1)).toEqual([
      "RoomResponseValidationError",
      endpoint === "profile"
        ? "player.profile"
        : endpoint === "rating"
          ? "rating.result"
          : `room.${endpoint}`,
    ]);
    assertStopped(socket);
  },
);

test("ルームを離れた後の共用取得の検証失敗では自動更新しない", async () => {
  const h = renderHook(useRoomSession, options(), wrap());
  connect();
  h.unmount();
  const pending = readRatingResult("four-reversi", "match", new AbortController().signal).catch(
    () => {},
  );
  requests.at(-1)!.respond({ privateBody: "SECRET" });
  await flush();
  await pending;
  expect(reload).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});
