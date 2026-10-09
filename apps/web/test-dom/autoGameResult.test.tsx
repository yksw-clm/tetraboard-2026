import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ComponentType } from "react";
import { createInitialState } from "@tetraboard/reversi";
import {
  publicReversiMatchDetailSchema,
  reversiRoomSchema,
  shogiRoomSchema,
  type Room,
  type RoomMembership,
  type RoomPresence,
} from "@tetraboard/protocol";
import archive from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { useAutoGameResult } from "../src/features/room/useAutoGameResult";
import RoomDetail from "../src/features/room/FourReversiRoomDetail";
import FourShogiRoomDetail from "../src/features/room/FourShogiRoomDetail";
import ReversiRoomDetail from "../src/features/room/ReversiRoomDetail";
import ShogiRoomDetail from "../src/features/room/ShogiRoomDetail";
import { playingRoom, waitingRoom, membership, now, playerIds } from "../test/fixtures/rooms";
import { finishedShogiRound, playingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import {
  standardPlayingRoom,
  standardSavedRound,
  standardWaitingRoom,
} from "../test/fixtures/standardShogiFixtures";
import { replayMatch } from "../test/fixtures/matchReplayFixtures";
import { profile } from "../test/fixtures/account";
import { act, clock, flush, press, render, renderHook, wrap } from "./harness";
import { installSocket, Socket } from "./socket";

type DetailProps<T extends Room> = {
  initialRoom: T;
  initialMembership: RoomMembership | null;
  initialServerNowMs: number;
  initialPresence: RoomPresence;
  invited: boolean;
};
function pair<T extends Room>(playing: T, ended: T, Detail: ComponentType<DetailProps<T>>) {
  return {
    playing,
    ended,
    renderDetail: (spectator: boolean) => (
      <Detail
        initialRoom={playing}
        initialMembership={spectator ? null : membership}
        initialServerNowMs={now}
        initialPresence={{ hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds }}
        invited={false}
      />
    ),
  };
}

function rounds() {
  const match = replayMatch();
  const fourEnded = {
    ...waitingRoom(),
    lastRound: {
      game: match.game,
      players: match.participants.map(({ id, name, color }) => ({ id, name, color })),
      replay: match.replay,
    },
  };
  const reversi = reversiRoomSchema.parse({
    ...waitingRoom(),
    settings: { game: "reversi", timeControl: waitingRoom().settings.timeControl },
    players: waitingRoom().players.slice(0, 2),
  });
  const reversiPlaying = reversiRoomSchema.parse({
    ...reversi,
    status: "playing",
    players: reversi.players.map((p, i) => ({ ...p, color: i === 0 ? "black" : "white" })),
    game: createInitialState(),
    clock: {
      remainingMainMs: { black: 300000, white: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
  const saved = publicReversiMatchDetailSchema.parse(archive.detail);
  const reversiEnded = reversiRoomSchema.parse({
    ...reversi,
    lastRound: {
      game: saved.game,
      players: saved.participants.map(({ id, name, color }) => ({ id, name, color })),
      replay: saved.replay,
    },
  });
  const shogi = standardSavedRound().match;
  const shogiEnded = shogiRoomSchema.parse({
    ...standardWaitingRoom(),
    lastRound: {
      roundId: shogi.id,
      game: shogi.game,
      players: shogi.participants.map(({ id, name, side }) => ({ id, name, side })),
      eventCount: shogi.replay.eventCount,
    },
  });
  return [
    pair(playingRoom(), fourEnded, RoomDetail),
    pair(playingShogiRoom(), finishedShogiRound().room, FourShogiRoomDetail),
    pair(reversiPlaying, reversiEnded, ReversiRoomDetail),
    pair(standardPlayingRoom(), shogiEnded, ShogiRoomDetail),
  ];
}
type Input = { room: Room; blocked: boolean; unavailable: boolean };
const useResultProbe = ({ room, blocked, unavailable }: Input) =>
  useAutoGameResult(room, blocked, unavailable);
const input = (room: Room): Input => ({ room, blocked: false, unavailable: false });

for (const { playing, ended } of rounds()) {
  test(`${playing.settings.game}: 初回の終了済み部屋は表示せず、毎局999ms/1000msで結果を表示`, () => {
    sessionStorage.setItem("tetraboard:registration-result-shown", "1");
    const initial = renderHook(useResultProbe, input(ended));
    clock.advance(1000);
    expect(initial.current.visible).toBe(false);
    initial.unmount();
    const h = renderHook(useResultProbe, input(playing));
    h.rerender(input(ended));
    clock.advance(500);
    h.rerender(input({ ...ended }));
    clock.advance(499);
    expect(h.current.visible).toBe(false);
    clock.advance(1);
    expect(h.current.visible).toBe(true);
    act(() => h.current.dismiss());
    h.rerender(input({ ...ended }));
    clock.advance(1000);
    expect(h.current.visible).toBe(false);
    h.rerender(input(playing));
    h.rerender(input(ended));
    clock.advance(1000);
    expect(h.current.visible).toBe(true);
  });
}

test("期限時点の競合で取り消し、期限前に競合が閉じれば元の期限で表示", () => {
  const playing = playingShogiRoom(),
    ended = finishedShogiRound().room;
  const h = renderHook(useResultProbe, input(playing));
  h.rerender({ ...input(ended), blocked: true });
  clock.advance(1000);
  expect(h.current.visible).toBe(false);
  h.rerender(input(ended));
  clock.advance(1000);
  expect(h.current.visible).toBe(false);
  h.rerender(input(playing));
  h.rerender({ ...input(ended), blocked: true });
  clock.advance(500);
  h.rerender(input(ended));
  clock.advance(499);
  expect(h.current.visible).toBe(false);
  clock.advance(1);
  expect(h.current.visible).toBe(true);
});

test("手動表示・次局・利用不能・世代変更・結果消失は保留を取り消す", () => {
  const playing = playingShogiRoom(),
    ended = finishedShogiRound().room;
  for (const reason of ["manual", "next", "unavailable", "generation", "missing"] as const) {
    const h = renderHook(useResultProbe, input(playing));
    h.rerender(input(ended));
    clock.advance(500);
    if (reason === "manual") act(() => h.current.dismiss());
    if (reason === "next") h.rerender(input(playing));
    if (reason === "unavailable") h.rerender({ ...input(ended), unavailable: true });
    if (reason === "generation")
      h.rerender(input({ ...ended, instanceId: "00000000-0000-4000-8000-000000000099" }));
    if (reason === "missing") h.rerender(input({ ...ended, lastRound: null }));
    clock.advance(500);
    expect(h.current.visible).toBe(false);
    if (reason !== "next") {
      h.rerender(input(ended));
      clock.advance(1000);
      expect(h.current.visible).toBe(false);
    }
    h.unmount();
  }
  const h = renderHook(useResultProbe, input(playing));
  h.rerender(input(ended));
  h.unmount();
  clock.advance(1000);
  const fresh = renderHook(useResultProbe, input(ended));
  clock.advance(1000);
  expect(fresh.current.visible).toBe(false);
});

let restoreSocket: () => void;
beforeEach(() => {
  restoreSocket = installSocket();
});
afterEach(() => restoreSocket());
for (const { playing, ended, renderDetail } of rounds()) {
  for (const loggedIn of [false, true]) {
    for (const spectator of [false, true]) {
      test(`${playing.settings.game}: ${loggedIn ? "ログイン" : "ゲスト"}/${spectator ? "観戦" : "参加"}にも結果を1秒後に表示`, async () => {
        const view = render(wrap(loggedIn ? profile : null)(renderDetail(spectator)));
        const socket = Socket.instances.at(-1)!;
        act(() => {
          socket.open();
          socket.snapshot(playing);
          if (!spectator) socket.receive({ type: "room.authenticated", membership });
          socket.snapshot(ended);
        });
        await flush();
        clock.advance(999);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        clock.advance(1);
        await flush();
        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog?.textContent).toContain("対局結果");
        expect(dialog?.textContent?.includes("今回のゲスト対局は")).toBe(!loggedIn);
        const close = dialog?.querySelector<HTMLButtonElement>('[aria-label="閉じる"]');
        if (!close) throw Error("Missing result close button");
        act(() => close.click());
        await flush();
        clock.advance(1000);
        await flush();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(view.textContent).toContain("結果");
        await press(view, "結果");
        await flush();
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain("対局結果");
      });
    }
  }
}
