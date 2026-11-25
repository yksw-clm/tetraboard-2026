import { afterEach, beforeEach, expect, test } from "bun:test";
import { StrictMode, type ComponentType } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createInitialState } from "@tetraboard/reversi";
import { createInitialState as initialGomoku } from "@tetraboard/gomoku";
import { createInitialState as initialFourGomoku } from "@tetraboard/four-gomoku";
import {
  publicReversiMatchDetailSchema,
  reversiRoomSchema,
  shogiRoomSchema,
  gomokuRoomSchema,
  fourGomokuRoomSchema,
  roomForEntryResponse,
  roomSchema,
  type AccountProfile,
  type Room,
  type RoomMembership,
  type RoomPresence,
} from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { AccountContext } from "../src/features/account/useAccount";
import { FourGomokuLobbyPage } from "../src/features/lobby/FourGomokuLobbyPage";
import { FourReversiLobbyPage } from "../src/features/lobby/FourReversiLobbyPage";
import { FourShogiLobbyPage } from "../src/features/lobby/FourShogiLobbyPage";
import { GomokuLobbyPage } from "../src/features/lobby/GomokuLobbyPage";
import { ReversiLobbyPage } from "../src/features/lobby/ReversiLobbyPage";
import { ShogiLobbyPage } from "../src/features/lobby/ShogiLobbyPage";
import { RoomPage } from "../src/features/room/RoomPage";
import { roomLoader } from "../src/features/room/roomLoader";
import { saveGuestName } from "../src/shared/guestName";
import { readRoomMembershipToken, saveRoomMembershipToken } from "../src/shared/roomMembership";
import archive from "../../../test-fixtures/matches/reversi-standard-draw.json";
import gomokuArchive from "../../../test-fixtures/matches/gomoku-on-five.json";
import fourGomokuArchive from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import { useAutoGameResult } from "../src/features/room/useAutoGameResult";
import RoomDetail from "../src/features/room/FourReversiRoomDetail";
import FourShogiRoomDetail from "../src/features/room/FourShogiRoomDetail";
import ReversiRoomDetail from "../src/features/room/ReversiRoomDetail";
import ShogiRoomDetail from "../src/features/room/ShogiRoomDetail";
import GomokuRoomDetail from "../src/features/room/GomokuRoomDetail";
import FourGomokuRoomDetail from "../src/features/room/FourGomokuRoomDetail";
import {
  playingRoom,
  waitingRoom,
  membership,
  now,
  playerIds,
  token,
} from "../test/fixtures/rooms";
import {
  finishedShogiRound,
  playingShogiRoom,
  shogiRoundWithoutHumans,
} from "../test/fixtures/fourShogiFixtures";
import {
  standardPlayingRoom,
  standardSavedRound,
  standardWaitingRoom,
} from "../test/fixtures/standardShogiFixtures";
import { replayMatch } from "../test/fixtures/matchReplayFixtures";
import { profile } from "../test/fixtures/account";
import { act, clock, flush, press, render, renderHook, requests, wrap } from "./harness";
import { guestProfile } from "./guestAccountFixtures";
import { installSocket, Socket } from "./socket";
import {
  createGuestRegistration,
  readGuestRegistration,
  saveGuestRegistration,
} from "../src/features/account/guestRegistration";

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
      players: match.participants.map(({ name, color }, index) => ({
        id: playerIds[index]!,
        name,
        color,
      })),
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
    roundId: "11111111-1111-4111-8111-111111111111",
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
      players: saved.participants.map(({ name, color }, index) => ({
        id: playerIds[index]!,
        name,
        color,
      })),
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
  const gomoku = gomokuRoomSchema.parse({
    ...waitingRoom(),
    settings: gomokuArchive.detail.settings,
    players: waitingRoom().players.slice(0, 2),
    roundId: null,
    positionRevision: 0,
  });
  const fourGomoku = fourGomokuRoomSchema.parse({
    ...waitingRoom(),
    settings: fourGomokuArchive.detail.settings,
    roundId: null,
    positionRevision: 0,
  });
  const gomokuPlaying = gomokuRoomSchema.parse({
    ...gomoku,
    status: "playing",
    roundId: gomokuArchive.detail.id,
    players: gomoku.players.map((p, i) => ({ ...p, color: i === 0 ? "black" : "white" })),
    game: initialGomoku(),
    clock: {
      remainingMainMs: { black: 300000, white: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
  const fourGomokuPlaying = fourGomokuRoomSchema.parse({
    ...fourGomoku,
    status: "playing",
    roundId: fourGomokuArchive.detail.id,
    players: fourGomoku.players.map((p, i) => ({
      ...p,
      color: ["black", "white", "red", "blue"][i],
    })),
    game: initialFourGomoku(),
    clock: {
      remainingMainMs: { black: 300000, white: 300000, red: 300000, blue: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
  const gomokuEnded = gomokuRoomSchema.parse({
    ...gomoku,
    lastRound: {
      settings: gomokuArchive.detail.settings,
      game: gomokuArchive.detail.game,
      replay: gomokuArchive.detail.replay,
      players: gomokuArchive.detail.participants.map(({ name, color }, i) => ({
        id: playerIds[i],
        name,
        color,
      })),
    },
  });
  const fourGomokuEnded = fourGomokuRoomSchema.parse({
    ...fourGomoku,
    lastRound: {
      settings: fourGomokuArchive.detail.settings,
      game: fourGomokuArchive.detail.game,
      replay: fourGomokuArchive.detail.replay,
      players: fourGomokuArchive.detail.participants.map(({ name, color }, i) => ({
        id: playerIds[i],
        name,
        color,
      })),
    },
  });
  return [
    pair(playingRoom(), fourEnded, RoomDetail),
    pair(playingShogiRoom(), finishedShogiRound().room, FourShogiRoomDetail),
    pair(reversiPlaying, reversiEnded, ReversiRoomDetail),
    pair(standardPlayingRoom(), shogiEnded, ShogiRoomDetail),
    pair(gomokuPlaying, gomokuEnded, GomokuRoomDetail),
    pair(fourGomokuPlaying, fourGomokuEnded, FourGomokuRoomDetail),
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
        if (!spectator) sessionStorage.setItem(`tetraboard:room:${playing.id}:membership`, token);
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
        expect(dialog?.textContent?.includes("この対局を、自分の記録に残そう")).toBe(!spectator);
        const close = dialog?.querySelector<HTMLButtonElement>('[aria-label="閉じる"]');
        if (!close) throw Error("Missing result close button");
        act(() => close.click());
        await flush();
        if (!spectator) {
          expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
            "遊んでみていかがでしたか？",
          );
          await press(document.body, "スキップ");
          await flush();
        }
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

test("最後の人間が脱落するとルームの結果に終局理由を表示する", async () => {
  const { playing, ended } = shogiRoundWithoutHumans();
  const { renderDetail } = pair(playing, ended, FourShogiRoomDetail);
  sessionStorage.setItem(`tetraboard:room:${playing.id}:membership`, token);
  render(wrap(profile)(renderDetail(false)));
  const socket = Socket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.snapshot(playing);
    socket.receive({ type: "room.authenticated", membership });
    socket.snapshot(ended);
  });
  await flush();
  clock.advance(1000);
  await flush();
  expect(document.querySelector('[aria-label="対局結果の詳細"]')?.textContent).toContain(
    "終局理由：人間のプレイヤーがいなくなったため",
  );
});

test("アカウント席からログアウトしてもゲスト対局の登録案内を出さない", async () => {
  const { playing, ended, renderDetail } = rounds()[0]!;
  sessionStorage.setItem(`tetraboard:room:${playing.id}:membership`, token);
  render(wrap()(renderDetail(false)));
  const socket = Socket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.snapshot(playing);
    socket.receive({
      type: "room.authenticated",
      membership: { ...membership, accountLinked: true },
    });
    socket.snapshot(ended);
  });
  await flush();
  clock.advance(1000);
  await flush();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("対局結果");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
    "この対局を、自分の記録に残そう",
  );
});

test.each([true, false])(
  "ゲスト本人に連携を案内し、結果操作を末尾に表示する（対人戦 %s）",
  async (humanOnly) => {
    const { playing, ended, renderDetail } = rounds()[0]!;
    const endedRoom = {
      ...ended,
      players: ended.players.map((player, index) =>
        index === 0 ? { ...player, isGuest: true } : player,
      ),
      lastRound: {
        ...ended.lastRound!,
        players: ended.lastRound!.players.map((player, index) =>
          !humanOnly && index === 1 ? { ...player, appearance: { kind: "cpu", level: 1 } } : player,
        ),
      },
    } as Room;
    const key = `tetraboard:room:${playing.id}:membership`;
    sessionStorage.setItem(key, token);
    const view = render(wrap(guestProfile())(renderDetail(false)));
    const socket = Socket.instances.at(-1)!;
    act(() => {
      socket.open();
      socket.snapshot(playing);
      socket.receive({
        type: "room.authenticated",
        membership: { ...membership, accountLinked: true },
      });
      socket.snapshot(endedRoom);
    });
    await flush();
    clock.advance(1000);
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const actions = dialog.querySelector('[aria-label="対局結果の操作"]')!;
    expect(actions.textContent).toBe("再戦棋譜を見る");
    expect(actions.nextElementSibling).toBeNull();
    const card = actions.previousElementSibling as HTMLElement;
    expect(card.querySelector("h2")?.textContent).toBe("アカウントを連携しよう");
    expect(card.textContent).toContain(
      humanOnly
        ? "これまでの戦績・棋譜・獲得したバッジ"
        : "別端末でも同じアカウントで遊べ、バッジ、戦績など各種機能をご利用いただけます。",
    );
    expect(card.querySelectorAll("figure")).toHaveLength(humanOnly ? 1 : 0);
    expect(card.textContent).not.toContain("連携後は、このルームに戻って再戦できます。");
    const buttons = card.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    const [google, discord] = buttons;
    expect(google?.textContent).toBe("Googleで続ける");
    expect(discord?.textContent).toBe("Discordで続ける");
    const consent = discord?.parentElement?.nextElementSibling;
    expect(consent?.textContent).toContain("続けることで、利用規約に同意し");
    expect(google?.getAttribute("aria-describedby")).toBe(consent?.id ?? null);
    expect(discord?.getAttribute("aria-describedby")).toBe(consent?.id ?? null);
    if (humanOnly) {
      press(card, "Discordで続ける");
      await flush();
      const prepare = requests.find(({ url }) => url === `/api/rooms/${playing.id}/registration`)!;
      const payload = JSON.parse(String(prepare.init.body));
      expect(payload).toMatchObject({ instanceId: playing.instanceId, linkGuest: true });
      prepare.respond({
        ...payload,
        roomId: playing.id,
        playerId: membership.playerId,
        holdUntilMs: Date.now() + 600000,
        claimUntilMs: Date.now() + 3600000,
        identity: "unverified",
        record: "unclaimed",
        seat: "held",
      });
      await flush();
      const auth = requests.find(({ url }) => url === "/api/auth/sign-in/social")!;
      expect(JSON.parse(String(auth.init.body))).toEqual({
        provider: "discord",
        registration: { registrationId: payload.registrationId, secret: payload.secret },
        analytics: { id: expect.any(String), entry: "room-result", game: playing.settings.game },
      });
      auth.respond({ message: "Discordログインは準備中です。" }, 503);
      await flush();
      requests.find(({ url }) => url.endsWith("/cancel"))!.respond(null, 204);
      await flush();
      expect(card.querySelector('[role="alert"]')?.textContent).toContain(
        "Discordログインは準備中です。",
      );
      expect(requests.some(({ url }) => url.endsWith("/leave"))).toBe(false);
      expect(sessionStorage.getItem(key)).toBe(token);
    }
    press(dialog, humanOnly ? "棋譜を見る" : "再戦");
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    if (humanOnly) {
      press(view, "結果");
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discordで続ける");
    } else {
      expect(socket.sent).toContainEqual({ type: "room.ready.set", ready: true });
    }
  },
);

test("登録待ちの席・残り時間を表示し、全員が準備済みでも再戦を開始させない", async () => {
  const { playing, ended, renderDetail } = rounds()[0]!;
  const pending = {
    ...ended,
    players: ended.players.map((player, index) => ({
      ...player,
      ready: true,
      ...(index === 0 ? { registrationPendingUntilMs: now + 600000 } : {}),
    })),
  } as Room;
  sessionStorage.setItem(`tetraboard:room:${playing.id}:membership`, token);
  const view = render(wrap()(renderDetail(false)));
  const socket = Socket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.snapshot(playing);
    socket.receive({ type: "room.authenticated", membership });
    socket.snapshot(pending);
  });
  await flush();
  expect(view.textContent).toContain("登録手続中");
  expect(view.textContent).toContain("残り10分0秒");
  const start = [...view.querySelectorAll("button")].find(
    (button) => button.textContent === "対局開始",
  )!;
  expect(start.disabled).toBe(true);
  clock.advance(2000);
  await flush();
  expect(view.textContent).toContain("残り9分58秒");
});

test("登録後の復帰情報は同じ席のアカウント資格がWebSocketで確認されてから消費する", async () => {
  const room = finishedShogiRound().room;
  const value = createGuestRegistration(room);
  saveGuestRegistration({
    ...value,
    returning: { playerId: membership.playerId, record: "pending" },
  });
  sessionStorage.setItem(`tetraboard:room:${room.id}:membership`, value.newToken);
  render(
    wrap(profile)(
      <FourShogiRoomDetail
        initialRoom={room}
        initialMembership={{ ...membership, accountLinked: true }}
        initialServerNowMs={now}
        initialPresence={{ hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds }}
        invited={false}
      />,
    ),
  );
  expect(readGuestRegistration()).not.toBeNull();
  const socket = Socket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.snapshot(room);
  });
  await flush();
  expect(readGuestRegistration()).not.toBeNull();
  act(() => {
    socket.receive({
      type: "room.authenticated",
      membership: { ...membership, accountLinked: true },
    });
  });
  await flush();
  expect(readGuestRegistration()).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "棋譜の保存を待っています",
  );
});

test("終局後に相手が退室しても前局の構成に従って対人戦の登録案内を表示する", async () => {
  const { playing, ended, renderDetail } = rounds()[0]!;
  if (!ended.lastRound) throw new Error("Expected ended round");
  const departed = {
    ...ended,
    players: ended.players.slice(0, 1),
    lastRound: {
      ...ended.lastRound,
      players: ended.lastRound.players.map((player) => ({
        ...player,
        appearance: { kind: "human", avatarUrl: null },
      })),
    },
  } as Room;
  sessionStorage.setItem(`tetraboard:room:${playing.id}:membership`, token);
  render(wrap()(renderDetail(false)));
  const socket = Socket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.snapshot(playing);
    socket.receive({ type: "room.authenticated", membership });
    socket.snapshot(departed);
  });
  await flush();
  clock.advance(1000);
  await flush();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("この対局の戦績と棋譜");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
    "通常ルームのCPU戦は",
  );
});

const lobbyPages = {
  "four-reversi": FourReversiLobbyPage,
  "four-shogi": FourShogiLobbyPage,
  reversi: ReversiLobbyPage,
  shogi: ShogiLobbyPage,
  gomoku: GomokuLobbyPage,
  "four-gomoku": FourGomokuLobbyPage,
};
const inviteLabel = "友達と遊ぶ";
const inheritedTimeControl = { mainTimeMs: 180_000, byoyomiMs: 10_000 };
const createRequests = () =>
  requests.filter(
    (request) => request.url === "/api/rooms?snapshot=1" && request.init.method === "POST",
  );

function cpuResult(room: Room, otherHumans = 0, missingAppearance = false) {
  const { lastRound } = room;
  if (!lastRound) throw new Error("Expected ended round");
  const game = room.settings.game;
  return roomSchema.parse({
    ...room,
    // CPUが退席して別の人が入った待機室です。
    players: [room.players[0], { ...room.players[1], id: "00000000-0000-4000-8000-000000000099" }],
    settings: {
      ...room.settings,
      timeControl: inheritedTimeControl,
      ...(gameCatalog[game].hasModes ? { mode: "doubles" } : {}),
      ...(game === "four-shogi" ? { threePlayerAttackProhibited: false } : {}),
      ...(game === "gomoku" ? { forbiddenRules: false } : {}),
    },
    lastRound: {
      ...lastRound,
      players: lastRound.players.map((player, index) => ({
        ...player,
        appearance:
          index <= otherHumans
            ? { kind: "human", avatarUrl: null }
            : missingAppearance && index === 1
              ? undefined
              : { kind: "cpu", level: 2 },
      })),
    },
  });
}

async function showResult(playing: Room, ended: Room, spectator = false) {
  const socket = Socket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.snapshot(playing);
    if (!spectator) socket.receive({ type: "room.authenticated", membership });
    socket.snapshot(ended);
  });
  await flush();
  clock.advance(1000);
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog?.textContent).toContain("対局結果");
  return dialog;
}

async function openCpuResult(
  { playing, ended, renderDetail }: ReturnType<typeof pair>,
  user: AccountProfile = profile,
) {
  const game = playing.settings.game;
  const lobbyPath = gameCatalog[game].lobbyPath;
  const router = createMemoryRouter(
    [
      { path: `/rooms/${playing.id}`, element: renderDetail(false) },
      { path: lobbyPath, Component: lobbyPages[game] },
      { path: "/rooms/:id", loader: roomLoader, Component: RoomPage, HydrateFallback: () => null },
    ],
    { initialEntries: [`/rooms/${playing.id}`] },
  );
  let intentState: { friendRoomNonce: string } | undefined;
  router.subscribe(({ location }) => {
    if (location.pathname === lobbyPath && location.state?.friendRoomNonce)
      intentState = JSON.parse(JSON.stringify(location.state));
  });
  saveRoomMembershipToken(playing.id, token);
  const view = render(
    <StrictMode>
      <AccountContext.Provider
        value={{ user, loading: false, error: null, refresh: async () => {}, update: () => {} }}
      >
        <RouterProvider router={router} />
      </AccountContext.Provider>
    </StrictMode>,
  );
  const finished = cpuResult(ended);
  const dialog = await showResult(playing, finished);
  const leaveRequests = () =>
    requests.filter((request) => request.url === `/api/rooms/${playing.id}/leave`);
  return {
    router,
    finished,
    dialog,
    view,
    leaveRequests,
    lobbyPath,
    intentState: () => intentState,
  };
}

for (const round of rounds()) {
  const game = round.playing.settings.game;
  test(`${game}: CPU戦の結果から同じ設定でルームを作り、共有を一度だけ開く`, async () => {
    const user = game === "gomoku" ? guestProfile() : profile;
    if (user.isGuest) saveGuestName(user.name);
    const { router, finished, dialog, view, leaveRequests, lobbyPath, intentState } =
      await openCpuResult(round, user);
    try {
      const invite = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === inviteLabel,
      )!;
      expect(invite.classList.contains("w-full")).toBe(true);
      expect(invite.previousElementSibling?.textContent).toContain("共有の準備中");
      expect(invite.nextElementSibling?.textContent).toContain("この対局を、自分の記録に残そう");
      press(dialog, inviteLabel);
      expect(invite.disabled).toBe(true);
      expect(invite.hasAttribute("data-pending")).toBe(true);
      press(dialog, inviteLabel);
      expect(leaveRequests()).toHaveLength(1);
      expect(leaveRequests()[0]!.init).toMatchObject({
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(createRequests()).toHaveLength(0);

      leaveRequests()[0]!.respond(null, 204);
      await flush();
      expect(readRoomMembershipToken(round.playing.id)).toBeNull();
      expect(router.state.location.pathname).toBe(lobbyPath);
      expect(router.state.location.state).toEqual({});
      expect(view.querySelector("button[data-pending]")?.textContent).toBe("公開ルームを作る");
      expect(createRequests()).toHaveLength(0);
      requests
        .find((request) => request.url === "/api/account/session" && !request.init.signal)!
        .respond({ user });
      await flush();
      expect(createRequests()).toHaveLength(1);
      expect(JSON.parse(String(createRequests()[0]!.init.body))).toEqual({
        ...(game === "four-reversi" ? {} : { game }),
        timeControl: inheritedTimeControl,
        quickPlay: false,
        ...(gameCatalog[game].hasModes ? { mode: "doubles" } : {}),
        ...(game === "four-shogi" ? { threePlayerAttackProhibited: false } : {}),
        ...(game === "gomoku" ? { forbiddenRules: false } : {}),
      });

      const created = roomSchema.parse({
        ...finished,
        id: "54321",
        instanceId: "00000000-0000-4000-8000-000000000012",
        lastRound: null,
        players: finished.players.slice(0, 1),
      });
      const newToken = "b".repeat(64);
      createRequests()[0]!.respond(
        {
          room: roomForEntryResponse(created),
          membership: { ...membership, token: newToken },
          snapshot: {
            room: created,
            presence: { hostPlayerId: membership.playerId, connectedPlayerIds: [] },
            serverNowMs: now,
          },
          currentMembership: membership,
        },
        201,
      );
      await flush();
      expect(router.state.location.pathname).toBe(`/rooms/${created.id}`);
      expect(readRoomMembershipToken(created.id)).toBe(newToken);
      const share = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(share.querySelector("h2")?.textContent).toBe("ルームを共有");
      expect(share.querySelector("input")?.value).toContain(`invite=${created.instanceId}`);
      act(() => share.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
      await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      if (game === "four-shogi") {
        expect(typeof intentState()?.friendRoomNonce).toBe("string");
        await act(() => router.navigate(-1));
        expect(router.state.location.pathname).toBe(lobbyPath);
        expect(createRequests()).toHaveLength(1);
        await act(() => router.navigate(lobbyPath, { state: intentState() }));
        await flush();
        expect(router.state.location.state).toEqual({});
        expect(createRequests()).toHaveLength(1);
      }
    } finally {
      router.dispose();
    }
  });
}

test.each(["ランダムマッチ", "レート戦", "大会", "人間が2人", "観戦者", "対局時の種別が不明"])(
  "%s の結果に「友達と遊ぶ」を出さない",
  async (reason) => {
    const { playing, ended, renderDetail } = rounds()[0]!;
    const spectator = reason === "観戦者";
    const room = roomSchema.parse({
      ...cpuResult(ended, reason === "人間が2人" ? 1 : 0, reason === "対局時の種別が不明"),
      players: ended.players.slice(0, 1),
      ...(reason === "大会" ? { tournamentId: 1 } : {}),
      ...(reason === "ランダムマッチ" || reason === "レート戦"
        ? {
            matchmaking: {
              id: ended.instanceId,
              preparedAtMs: now,
              ...(reason === "レート戦" ? { rated: true } : {}),
            },
          }
        : {}),
    });
    if (!spectator) saveRoomMembershipToken(playing.id, token);
    render(wrap(profile)(renderDetail(spectator)));
    const dialog = await showResult(playing, room, spectator);
    expect(dialog.textContent).not.toContain(inviteLabel);
  },
);

test("退室の失敗は結果に表示して再試行でき、作成の失敗はロビーに表示する", async () => {
  const { router, dialog, view, leaveRequests, lobbyPath } = await openCpuResult(rounds()[0]!);
  try {
    press(dialog, inviteLabel);
    leaveRequests()[0]!.respond({ error: "internal_error" }, 500);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      "退室できませんでした。再度お試しください。",
    );
    expect(readRoomMembershipToken("12345")).toBe(token);
    expect(createRequests()).toHaveLength(0);
    press(dialog, inviteLabel);
    expect(leaveRequests()).toHaveLength(2);
    leaveRequests()[1]!.respond(null, 204);
    await flush();
    requests
      .find((request) => request.url === "/api/account/session" && !request.init.signal)!
      .respond({ user: profile });
    await flush();
    createRequests()[0]!.respond({ error: "internal_error" }, 500);
    await flush();
    expect(router.state.location.pathname).toBe(lobbyPath);
    expect(
      [...view.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
    ).toContain("ルームを作成できませんでした。もう一度お試しください。");
    expect(view.querySelector("button[data-pending]")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(createRequests()).toHaveLength(1);
  } finally {
    router.dispose();
  }
});

test("結果から登録手続きを始めると、退室操作を受け付けない", async () => {
  const { router, finished, dialog, leaveRequests } = await openCpuResult(rounds()[0]!);
  try {
    press(dialog, "Discordで続ける");
    await flush();
    const registration = requests.find(
      (request) => request.url === `/api/rooms/${finished.id}/registration`,
    )!;
    expect(registration).toBeDefined();
    const invite = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent === inviteLabel,
    )!;
    expect(invite.disabled).toBe(true);
    press(dialog, inviteLabel);
    expect(leaveRequests()).toHaveLength(0);

    registration.respond({ error: "internal_error" }, 500);
    await flush();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      "登録の引継ぎを確認できません。再試行してください。",
    );
    expect(
      [...dialog.querySelectorAll("button")].find((button) => button.textContent === inviteLabel)
        ?.disabled,
    ).toBe(false);
  } finally {
    router.dispose();
  }
});
