import { afterEach, beforeEach, expect, test } from "bun:test";
import { createInitialState, applyAction } from "@tetraboard/reversi";
import {
  reversiRoomSchema,
  publicReversiMatchDetailSchema,
  roomTimeControl,
} from "@tetraboard/protocol";
import archive from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { ProfilePage } from "../src/features/account/AccountPages";
import { LobbyRankings } from "../src/features/lobby/LobbyRankings";
import { RoomEntryDialog } from "../src/features/lobby/RoomEntryDialog";
import { HowToPlayDialog } from "../src/features/lobby/HowToPlayDialog";
import ReversiRoomDetail from "../src/features/room/ReversiRoomDetail";
import ReversiMatchReplayView from "../src/features/room/ReversiMatchReplayView";
import { useReversiSession } from "../src/features/room/useReversiSession";
import { createRoomRequests } from "../src/features/lobby/createRoomRequests";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import { profile } from "../test/fixtures/account";
import { waitingRoom, membership, token, now, playerIds } from "../test/fixtures/rooms";
import { act, clock, flush, press, render, renderHook, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";
let restore: () => void;
beforeEach(() => {
  restore = installSocket();
});
afterEach(() => restore());
function waiting() {
  const room = waitingRoom();
  return reversiRoomSchema.parse({
    ...room,
    settings: { game: "reversi", timeControl: roomTimeControl },
    players: room.players.slice(0, 2),
  });
}
function playing() {
  const room = waiting();
  return reversiRoomSchema.parse({
    ...room,
    status: "playing",
    players: room.players.map((p, i) => ({ ...p, color: i === 0 ? "black" : "white" })),
    game: createInitialState(),
    clock: {
      remainingMainMs: { black: 300000, white: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
}
const options = (room: ReturnType<typeof waiting>) => ({
  initialRoom: room,
  initialMembership: membership,
  initialServerNowMs: now,
  initialPresence: { hostPlayerId: playerIds[0], connectedPlayerIds: playerIds.slice(0, 2) },
});
function connect(room: ReturnType<typeof waiting>) {
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive({ type: "room.authenticated", membership });
  return socket;
}
test("通常リバーシの作成・遊び方はCPU1人、モード選択なし", async () => {
  const props = {
    game: "reversi" as const,
    intent: "quick" as const,
    registrationPath: "/games/reversi",
    name: "ゲスト",
    roomCode: "",
    mode: "singles" as const,
    timeControl: roomTimeControl,
    busy: false,
    message: null,
    onTimeControlChange() {},
    onNameChange() {},
    onRoomCodeChange() {},
    onModeChange() {},
    onSubmit() {},
    onClose() {},
  };
  render(wrap()(<RoomEntryDialog {...props} />));
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("CPUと対戦");
  expect(dialog.textContent).not.toContain("シングルス");
  expect(dialog.textContent).not.toContain("ダブルス");
  expect(dialog.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  const request = createRoomRequests.reversi({
    name: "ゲスト",
    quickPlay: true,
    mode: "singles",
    timeControl: roomTimeControl,
  });
  expect(request).toEqual({
    game: "reversi",
    name: "ゲスト",
    quickPlay: true,
    timeControl: roomTimeControl,
  });
});
test("遊び方に自動パス・引き分け・全滅手許可を表示する", () => {
  render(wrap()(<HowToPlayDialog game="reversi" onClose={() => {}} />));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("相手の石を0枚にする手も置けます");
  expect(dialog.textContent).toContain("自動パス");
  expect(dialog.textContent).toContain("引き分け");
  expect(dialog.textContent).not.toContain("シングルス");
});
test("通常リバーシのマイページは5戦績項目、引き分けを分母に含む率、バッジとモードなし", async () => {
  const state = {
    accountSelection: {
      game: "reversi",
      modes: { "four-reversi": "singles", "four-shogi": "singles", reversi: "singles" },
    },
  };
  const view = render(wrap(profile, { pathname: "/account", state })(<ProfilePage />));
  clock.advance(0);
  for (const request of requests) {
    expect(request.url).not.toContain("mode=");
    if (request.url.includes("/stats?"))
      request.respond({ total: 4, wins: 1, losses: 2, draws: 1 });
    else if (request.url.includes("/matches?")) request.respond({ matches: [], nextCursor: null });
  }
  await flush();
  expect([...view.querySelectorAll("dt")].map((n) => n.textContent)).toEqual([
    "対局数",
    "勝数",
    "勝率",
    "敗数",
    "敗率",
  ]);
  expect(view.textContent).toContain(".250");
  expect(view.textContent).toContain(".500");
  expect(view.querySelector('[role="tablist"]:not([hidden])')).toBeNull();
  expect(view.textContent).not.toContain("シングルス");
  expect(view.textContent).not.toContain("未獲得");
  expect(view.querySelector('a[href="/games/reversi"]')).not.toBeNull();
});
test("通常リバーシのランキングは勝数3人・詳細10人、対局数切替、モードタブなし", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1,
    username: `user${i}`,
    name: `参加者${i}`,
    avatarUrl: null,
    value: 10 - i,
  }));
  const view = render(wrap()(<LobbyRankings game="reversi" theme="reversi" />));
  clock.advance(0);
  expect(requests.at(-1)!.url).toBe("/api/games/reversi/rankings?profilePreview=1");
  requests.at(-1)!.respond({ wins: entries, total: entries });
  await flush();
  expect(view.querySelectorAll("li")).toHaveLength(3);
  expect(view.textContent).toContain("勝数");
  expect(view.querySelector('[role="tablist"]:not([hidden])')).toBeNull();
  press(view, "もっと見る");
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelectorAll("li")).toHaveLength(10);
  expect(dialog.textContent).not.toContain("シングルス");
  act(() => dialog.querySelector<HTMLElement>('[role="tab"][id$="total"]')!.click());
  await flush();
  expect(dialog.querySelector("h3")!.textContent).toBe("対局数");
});
test("通常リバーシの待機画面はカード2人、設定からモードを省き、満席でCPU追加を止める", async () => {
  const room = waiting();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<ReversiRoomDetail {...options(room)} invited={false} />));
  connect(room);
  expect(view.querySelectorAll('[data-testid="player-card"]')).toHaveLength(2);
  expect(view.querySelectorAll('[aria-label="リバーシの盤面"] button:enabled')).toHaveLength(0);
  press(view, "ルーム設定");
  await flush();
  clock.advance(300);
  expect(view.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(view.textContent).not.toContain("シングルス");
  expect(
    [...view.querySelectorAll("button")].find((b) => b.textContent?.includes("CPUを追加"))
      ?.disabled,
  ).toBe(true);
});
test("通常リバーシの着手は合法手のみ送信し、重複を止めて受信局面で完了する", () => {
  const room = playing();
  if (room.status !== "playing") throw Error("Expected playing");
  saveRoomMembershipToken(room.id, token);
  const h = renderHook(useReversiSession, options(room), wrap());
  const socket = connect(room);
  act(() => h.current.handlePlaceStone({ x: 0, y: 0 }));
  expect(socket.sent.filter((m) => m.type === "room.game.action")).toHaveLength(0);
  act(() => {
    h.current.handlePlaceStone({ x: 3, y: 2 });
    h.current.handlePlaceStone({ x: 3, y: 2 });
  });
  expect(socket.sent.filter((m) => m.type === "room.game.action")).toHaveLength(1);
  expect(h.current.pendingGameAction?.type).toBe("move");
  const moved = applyAction(room.game, { type: "placeStone", position: { x: 3, y: 2 } });
  if (!moved.ok) throw Error("Expected move");
  socket.snapshot(reversiRoomSchema.parse({ ...room, game: moved.state }));
  expect(h.current.pendingGameAction).toBeNull();
  expect(h.current.canPlay).toBe(false);
});
test("通常リバーシの投了確認は敗北になることを案内する", async () => {
  const room = playing();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<ReversiRoomDetail {...options(room)} invited={false} />));
  connect(room);
  press(view, "投了");
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("投了すると敗北になります");
  expect(dialog.textContent).not.toContain("脱落");
});
test("保存棋譜は本人を下にして2人表示し、180度回転を案内・実行する", () => {
  const detail = publicReversiMatchDetailSchema.parse(archive.detail);
  const view = render(
    wrap()(
      <ReversiMatchReplayView match={{ ...detail, selfPlayerId: detail.participants[1].id }} />,
    ),
  );
  expect(view.querySelectorAll('[data-testid="player-card"]')).toHaveLength(2);
  const board = view.querySelector('[aria-label="リバーシの盤面"]')!;
  expect(board.querySelector("button")!.getAttribute("aria-label")).toStartWith("A1");
  const rotation = view.querySelector<HTMLButtonElement>(
    '[aria-label="盤面を時計回りに180度回転"]',
  )!;
  expect(rotation).not.toBeNull();
  act(() => rotation.click());
  expect(board.querySelector("button")!.getAttribute("aria-label")).toStartWith("H8");
  expect(view.textContent).not.toContain("シングルス");
});
