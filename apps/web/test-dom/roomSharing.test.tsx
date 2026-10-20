import { completeGuestAccount } from "./guestAccountFixtures";
import { expect, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { useLocation } from "react-router";
import { roomSchema, type Room } from "@tetraboard/protocol";
import { gameIds, gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { roomRecruitmentText } from "@tetraboard/protocol/room-sharing";
import { RoomShareDialog } from "../src/features/room/RoomShareDialog";
import { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { useRoomEntry } from "../src/features/lobby/useRoomEntry";
import {
  createRoomShareIntent,
  canOpenCreatedRoomShare,
  consumeRoomShareIntent,
} from "../src/features/room/roomShareIntent";
import { updatePageMetadata } from "../src/seo/pageMetadata";
import { membership, token, waitingRoom, playingRoom } from "../test/fixtures/rooms";
import { waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { standardWaitingRoom } from "../test/fixtures/standardShogiFixtures";
import { fourGomokuWaitingRoom } from "../test/fixtures/fourGomokuFixtures";
import { act, flush, press, render, renderHook, rerender, requests, wrap } from "./harness";

function fixture(game: GameId): Room {
  const base = waitingRoom();
  base.players = base.players.slice(0, 1);
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
                ...(game === "gomoku" ? { roundId: null, positionRevision: 0 } : {}),
              });
  return { ...room, players: room.players.slice(0, 1) } as Room;
}

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
      requests[0]!.respond({ user: null });
      await flush();
      const room = fixture(game);
      const submitted = await completeGuestAccount("ホスト");
      submitted.respond({ room, membership: { ...membership, token } }, 201);
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
