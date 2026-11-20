import { roomForEntryResponse } from "@tetraboard/protocol";
import { completeGuestAccount } from "./guestAccountFixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { roomSchema, type Room } from "@tetraboard/protocol";
import { gameIds, gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { roomRecruitmentText } from "@tetraboard/protocol/room-sharing";
import { AccountContext } from "../src/features/account/useAccount";
import { RoomPage } from "../src/features/room/RoomPage";
import { RoomShareDialog } from "../src/features/room/RoomShareDialog";
import { roomLoader } from "../src/features/room/roomLoader";
import { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { useRoomEntry } from "../src/features/lobby/useRoomEntry";
import {
  createRoomShareIntent,
  canOpenCreatedRoomShare,
  consumeRoomShareIntent,
} from "../src/features/room/roomShareIntent";
import { updatePageMetadata } from "../src/seo/pageMetadata";
import { profile } from "../test/fixtures/account";
import { membership, now, token, waitingRoom, playingRoom } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { standardWaitingRoom } from "../test/fixtures/standardShogiFixtures";
import { fourGomokuWaitingRoom } from "../test/fixtures/fourGomokuFixtures";
import { act, flush, press, render, renderHook, rerender, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";

function fixture(game: GameId, playerCount = 1): Room {
  const base = waitingRoom();
  base.players = base.players.slice(0, playerCount);
  const room =
    game === "four-shogi"
      ? waitingShogiRoom()
      : game === "shogi"
        ? standardWaitingRoom()
        : game === "four-gomoku"
          ? fourGomokuWaitingRoom()
          : game === "four-reversi"
            ? base
            : roomSchema.parse({
                ...base,
                settings: {
                  game,
                  timeControl: base.settings.timeControl,
                  ...(game === "gomoku" ? { forbiddenRules: true } : {}),
                },
                roundId: null,
                positionRevision: 0,
              });
  return { ...room, players: room.players.slice(0, playerCount) } as Room;
}

describe("招待リンクからのルーム参加", () => {
  beforeAll(async () => {
    // 初回描画を待つ間に、遅延読み込みのための実時間に依存しないようにします。
    await Promise.all([
      import("../src/features/room/FourReversiRoomDetail"),
      import("../src/features/room/FourShogiRoomDetail"),
      import("../src/features/room/ReversiRoomDetail"),
      import("../src/features/room/GomokuRoomDetail"),
      import("../src/features/room/FourGomokuRoomDetail"),
      import("../src/features/room/ShogiRoomDetail"),
    ]);
  });
  let restoreSocket: () => void;
  beforeEach(() => {
    restoreSocket = installSocket();
  });
  afterEach(() => restoreSocket());

  function snapshot(room: Room) {
    return {
      room,
      presence: { hostPlayerId: room.players[0]!.id, connectedPlayerIds: [] },
      serverNowMs: now,
    };
  }

  async function submitInvitation(room: Room) {
    const router = createMemoryRouter(
      [
        {
          path: "/rooms/:id",
          loader: roomLoader,
          Component: RoomPage,
          HydrateFallback: () => null,
        },
      ],
      { initialEntries: [`/rooms/${room.id}?invite=${room.instanceId}`] },
    );
    const view = render(
      <AccountContext.Provider
        value={{
          user: profile,
          loading: false,
          error: null,
          refresh: async () => {},
          update: () => {},
        }}
      >
        <RouterProvider router={router} />
      </AccountContext.Provider>,
    );
    requests[0]!.respond(snapshot(room));
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog?.textContent ?? view.textContent).toContain(`ルーム ${room.id} に参加`);
    press(dialog, "参加する");
    requests[1]!.respond({ user: profile });
    await flush();
    requests[2]!.respond(snapshot(room));
    await flush();
    const join = requests[3]!;
    expect(join.url).toBe(`/api/rooms/${room.id}/players?snapshot=1`);
    return { view, join };
  }

  test.each([...gameIds])("%s は参加成功後にダイアログが閉じて準備完了できる", async (game) => {
    const room = fixture(game, 2);
    const participant = { playerId: room.players[1]!.id, role: "player" as const };
    const { view, join } = await submitInvitation(fixture(game));
    join.respond({
      room: roomForEntryResponse(room),
      membership: { ...participant, token },
      snapshot: snapshot(room),
      currentMembership: { ...participant, accountLinked: true },
    });
    await flush();

    expect(document.querySelector('[role="dialog"]')?.textContent).toBeUndefined();
    const socket = Socket.instances.at(-1)!;
    socket.open();
    socket.snapshot(room);
    socket.receive({ type: "room.authenticated", membership: participant });
    press(view, "準備完了");
    expect(socket.sent.at(-1)).toEqual({ type: "room.ready.set", ready: true });
  });

  test("満室で参加に失敗するとダイアログにエラーが表示される", async () => {
    const { join } = await submitInvitation(fixture("reversi"));
    join.respond({ error: "room_full" }, 409);
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain("このルームは満室です");
  });
});

test("全6ゲームの通常作成だけが作成者・世代を照合する共有意図を渡す", async () => {
  for (const game of gameIds) {
    for (const intent of ["create", "quick"] as const) {
      requests.length = 0;
      const h = renderHook(
        () => ({ entry: useRoomEntry(game), location: useLocation() }),
        undefined,
        wrap(),
      );
      act(() => h.current.entry.setName("ホスト"));
      act(() => void h.current.entry.submitRoom(intent));
      const room = fixture(game);
      const submitted = await completeGuestAccount("ホスト", 0);
      submitted.respond(
        { room: roomForEntryResponse(room), membership: { ...membership, token } },
        201,
      );
      await flush();
      expect(h.current.location.pathname).toBe(`/rooms/${room.id}`);
      expect(canOpenCreatedRoomShare(h.current.location.state, room, membership)).toBe(
        intent === "create",
      );
      consumeRoomShareIntent(h.current.location.state);
      h.unmount();
    }
  }
});

test("作成の共有はStrictModeと履歴stateの複製でも1回だけ、世代・本人・権限を照合する", () => {
  const room = fixture("four-shogi");
  const state = JSON.parse(JSON.stringify(createRoomShareIntent(room, membership)));
  expect(canOpenCreatedRoomShare(state, { ...room, instanceId: "another" }, membership)).toBe(
    false,
  );
  expect(canOpenCreatedRoomShare(state, room, null)).toBe(false);
  expect(canOpenCreatedRoomShare(state, room, { ...membership, role: "player" })).toBe(false);
  const wrapper = wrap(null, { pathname: `/rooms/${room.id}`, state });
  const h = renderHook(
    () => useRoomInvitation(room, membership, false, () => {}),
    undefined,
    (child) => wrapper(<StrictMode>{child}</StrictMode>),
  );
  expect(h.current.dialog).toBe("share");
  act(() => h.current.close());
  h.rerender(undefined);
  expect(h.current.dialog).toBeNull();
  h.unmount();
  const back = renderHook(
    () => useRoomInvitation(room, membership, false, () => {}),
    undefined,
    wrapper,
  );
  expect(back.current.dialog).toBeNull();
  const untrusted = {
    roomShare: {
      roomId: room.id,
      instanceId: room.instanceId,
      playerId: membership.playerId,
      nonce: "unknown",
    },
  };
  expect(canOpenCreatedRoomShare(untrusted, room, membership)).toBe(false);
});

test("共有ダイアログはURLコピー・再試行・X文章と最新の満室状態、観戦者の手動表示に対応する", async () => {
  let copied = 0;
  const write = spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  function Probe({ room }: { room: Room }) {
    const invitation = useRoomInvitation(room, null, false, () => {});
    return (
      <>
        <button onClick={invitation.openShare}>共有入口</button>
        {invitation.dialog === "share" && (
          <RoomShareDialog
            game={room.settings.game}
            invitation={invitation}
            theme="default"
            onCopied={() => copied++}
          />
        )}
      </>
    );
  }
  try {
    const room = fixture("four-reversi");
    const view = render(wrap()(<Probe room={room} />));
    press(view, "共有入口");
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    expect(input.readOnly).toBe(true);
    expect(input.value).toContain(`invite=${room.instanceId}`);
    const link = dialog.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(new URL(link.href).searchParams.get("text")).toBe(
      roomRecruitmentText("four-reversi", input.value),
    );
    expect(link.rel).toBe("noopener noreferrer");
    press(dialog, "ルームURLをコピー");
    await flush();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("コピーできませんでした");
    expect(write).toHaveBeenCalledWith(input.value);
    write.mockResolvedValue();
    press(dialog, "ルームURLをコピー");
    await flush();
    expect(copied).toBe(1);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    rerender(view, wrap()(<Probe room={waitingRoom()} />));
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('a[target="_blank"]')).toBeNull();
    expect(dialog.textContent).toContain("満室のため");
    expect(
      [...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Xで"))
        ?.disabled,
    ).toBe(true);
    rerender(view, wrap()(<Probe room={playingRoom()} />));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("対局中のため");
    rerender(view, wrap()(<Probe room={room} />));
    expect(document.querySelector('[role="dialog"] a[target="_blank"]')).not.toBeNull();
  } finally {
    write.mockRestore();
  }
});

test("閉じた後・unmount後の遅いコピー失敗で共有を再表示しない", async () => {
  let reject!: (error: Error) => void;
  const write = spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  try {
    const h = renderHook(
      () => useRoomInvitation(fixture("four-shogi"), membership, false, () => {}),
      undefined,
      wrap(),
    );
    act(() => h.current.openShare());
    act(() => void h.current.copy(() => {}));
    act(() => h.current.close());
    reject(new Error("late"));
    await flush();
    expect(h.current.dialog).toBeNull();
    expect(h.current.copyError).toBeNull();
    act(() => h.current.openShare());
    act(() => void h.current.copy(() => {}));
    h.unmount();
    reject(new Error("late"));
    await flush();
  } finally {
    write.mockRestore();
  }
});

test("ルーム間とロビー・アカウントへの移動で共有メタ情報を残さない", () => {
  for (const game of gameIds) {
    const room = fixture(game);
    updatePageMetadata(`/rooms/${room.id}`, room);
    expect(document.title).toBe(`${gameCatalog[game].name}のルーム | TetraBoard`);
    expect(
      document.head.querySelector('meta[property="og:image"]')?.getAttribute("content"),
    ).toContain(`/assets/ogp/${game}.png`);
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex,follow",
    );
  }
  updatePageMetadata("/rooms/54321", fixture("four-shogi"));
  expect(
    document.head.querySelector('meta[property="og:image"]')?.getAttribute("content"),
  ).toContain("tetraboard.png");
  updatePageMetadata("/games/four-reversi");
  expect(document.head.querySelector('meta[property="og:image"]')).toBeNull();
  expect(document.head.querySelector('meta[property="og:title"]')).toBeNull();
  expect(document.head.querySelectorAll('meta[property="og:site_name"]')).toHaveLength(1);
  expect(
    document.head.querySelector('meta[property="og:site_name"]')?.getAttribute("content"),
  ).toBe("TetraBoard");
  updatePageMetadata("/account");
  expect(document.head.querySelector('meta[name^="twitter:"]')).toBeNull();
});
