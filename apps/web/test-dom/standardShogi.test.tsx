import { beforeEach, afterEach, expect, test } from "bun:test";
import { applyAction } from "@tetraboard/shogi";
import { ShogiLobbyBoardPreview } from "../src/features/lobby/ShogiLobbyBoardPreview";
import { ProfilePage } from "../src/features/account/AccountPages";
import { RoomEntryDialog } from "../src/features/lobby/RoomEntryDialog";
import { LobbyRankings } from "../src/features/lobby/LobbyRankings";
import ShogiRoomDetail from "../src/features/room/ShogiRoomDetail";
import { FourShogiBoardLayout } from "../src/features/room/FourShogiBoardLayout";
import { useShogiRoomSession } from "../src/features/room/useShogiRoomSession";
import ShogiMatchReplayView from "../src/features/room/ShogiMatchReplayView";
import {
  createShogiReplayFrame,
  applyShogiReplayEvent,
} from "../src/features/room/standardShogiReplayV1";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import {
  standardWaitingRoom,
  standardPlayingRoom,
  standardInitialState,
  standardPublicState,
  standardSavedRound,
} from "../test/fixtures/standardShogiFixtures";
import { profile } from "../test/fixtures/account";
import { playerIds, now, membership, token } from "../test/fixtures/rooms";
import { act, clock, flush, press, render, renderHook, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";
let restore: () => void;
beforeEach(() => {
  restore = installSocket();
});
afterEach(() => restore());
const options = (room: ReturnType<typeof standardWaitingRoom>) => ({
  initialRoom: room,
  initialMembership: membership,
  initialServerNowMs: now,
  initialPresence: { hostPlayerId: playerIds[0], connectedPlayerIds: playerIds.slice(0, 2) },
});
function connect(room: ReturnType<typeof standardWaitingRoom>) {
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  socket.receive({ type: "room.authenticated", membership });
  return socket;
}
test("通常将棋の作成はCPU1人・モードなしで、ロビー初期図は40駒", async () => {
  const room = standardWaitingRoom();
  render(
    wrap()(
      <RoomEntryDialog
        game="shogi"
        intent="quick"
        registrationPath="/games/shogi"
        name="ゲスト"
        roomCode=""
        mode="singles"
        timeControl={room.settings.timeControl}
        busy={false}
        message={null}
        onTimeControlChange={() => {}}
        onNameChange={() => {}}
        onRoomCodeChange={() => {}}
        onModeChange={() => {}}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("CPUと対戦");
  expect(dialog.textContent).not.toContain("シングルス");
  expect(dialog.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  const preview = render(<ShogiLobbyBoardPreview />);
  expect(preview.querySelectorAll('[data-testid="shogi-piece"]')).toHaveLength(40);
});
test("通常将棋のマイページは5項目と引き分けを含む率、モード・バッジなし", async () => {
  const state = {
    accountSelection: {
      game: "shogi",
      modes: {
        "four-reversi": "singles",
        "four-shogi": "singles",
        reversi: "singles",
        shogi: "singles",
      },
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
  expect(view.textContent).not.toContain("シングルス");
  expect(view.textContent).not.toContain("未獲得");
  expect(view.querySelector('a[href="/games/shogi"]')).not.toBeNull();
});
test("通常将棋ランキングは勝数3人と詳細10人でモードタブを表示しない", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1,
    username: `user${i}`,
    name: `参加者${i}`,
    avatarUrl: null,
    value: 10 - i,
  }));
  const view = render(wrap()(<LobbyRankings game="shogi" theme="shogi" />));
  clock.advance(0);
  expect(requests.at(-1)!.url).toBe("/api/games/shogi/rankings?profilePreview=1");
  requests.at(-1)!.respond({ wins: entries, total: entries });
  await flush();
  expect(view.querySelectorAll("li")).toHaveLength(3);
  press(view, "もっと見る");
  await flush();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelectorAll("li")).toHaveLength(10);
  expect(dialog.textContent).not.toContain("シングルス");
});
test("上下2カードと各7種類の持ち駒を左右カードなしで表示する", () => {
  const initial = standardInitialState();
  const hand = { pawn: 2, lance: 1, knight: 1, silver: 1, gold: 1, bishop: 1, rook: 1 };
  const game = standardPublicState({ ...initial, hands: { south: hand, north: hand } });
  const props = {
    standard: true,
    game,
    viewerSide: "south" as const,
    revision: 0,
    canPlay: false,
    legalActions: [],
    onAction: () => false,
    playerCards: { south: "先手カード", north: "後手カード" },
  };
  const view = render(<FourShogiBoardLayout {...props} />);
  expect(view.querySelectorAll("[data-side]")).toHaveLength(2);
  const top = view.querySelector('[data-side="north"]')!,
    bottom = view.querySelector('[data-side="south"]')!;
  expect(top.textContent).toContain("後手カード");
  expect(bottom.textContent).toContain("先手カード");
  for (const side of [top, bottom])
    expect(side.querySelectorAll("[data-hand-kind]")).toHaveLength(7);
  expect(view.querySelector('[data-hand-kind="pawn"]')?.getAttribute("aria-label")).toContain(
    "2枚",
  );
  expect(view.querySelector('[data-side="west"]')).toBeNull();
});
test("通常将棋の待機画面と設定には左右カード・モード・三人攻撃禁止がない", async () => {
  const room = standardWaitingRoom();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<ShogiRoomDetail {...options(room)} invited={false} />));
  connect(room);
  expect(view.querySelectorAll('[data-testid="player-card"]')).toHaveLength(2);
  expect(view.textContent).not.toContain("持将棋提案");
  press(view, "ルーム設定");
  await flush();
  clock.advance(300);
  expect(view.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(view.textContent).not.toContain("シングルス");
  expect(view.textContent).not.toContain("三人攻撃禁止");
});
test("通常将棋の着手は局revision付きで一度だけ送り、受信局面で完了する", () => {
  const room = standardPlayingRoom();
  saveRoomMembershipToken(room.id, token);
  const h = renderHook(useShogiRoomSession, options(room), wrap());
  const socket = connect(room);
  act(() => {
    h.current.handleShogiAction(room.legalActions[0]);
    h.current.handleShogiAction(room.legalActions[0]);
  });
  const moves = socket.sent.filter((m) => m.type === "room.game.action");
  expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({ roundId: room.roundId, positionRevision: 0 });
  expect(h.current.pendingGameAction?.type).toBe("move");
  const next = applyAction(standardInitialState(), "south", room.legalActions[0]);
  if (!next.ok) throw Error(next.reason);
  socket.snapshot(standardPlayingRoom(next.state, 1));
  expect(h.current.pendingGameAction).toBeNull();
  expect(h.current.canPlay).toBe(false);
});
test("持将棋ボタンは入玉した局面のみで表示し、本人の手番外でも提案できる", async () => {
  const initial = standardInitialState(),
    board = initial.board.map((row) =>
      row.map(() => null),
    ) as (typeof initial.board)[number][number][][];
  board[1][4] = { id: 1, side: "south", kind: "king", promoted: false };
  board[8][8] = { id: 2, side: "north", kind: "king", promoted: false };
  const room = standardPlayingRoom({ ...initial, board, turn: "north" });
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<ShogiRoomDetail {...options(room)} invited={false} />));
  const socket = connect(room);
  press(view, "持将棋提案");
  await flush();
  expect(socket.sent.filter((m) => m.type === "room.game.draw.set")).toEqual([
    { type: "room.game.draw.set", roundId: room.roundId, positionRevision: 0, proposed: true },
  ]);
  expect(view.textContent).not.toContain("入玉宣言");
});
test("入玉宣言は条件不足の敗北を確認してから局revision付きで送信する", async () => {
  const room = standardPlayingRoom();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<ShogiRoomDetail {...options(room)} invited={false} />));
  const socket = connect(room);
  press(view, "入玉宣言");
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("条件を満たさない宣言は敗北になります");
  expect(socket.sent.filter((m) => m.type === "room.game.declare")).toHaveLength(0);
  clock.advance(300);
  await flush();
  press(document.body, "宣言する");
  await flush();
  expect(socket.sent.filter((m) => m.type === "room.game.declare")).toEqual([
    { type: "room.game.declare", roundId: room.roundId, positionRevision: 0 },
  ]);
});
test("保存棋譜は本人を下に置き、180度回転と読み取り専用の巻き戻しを行う", () => {
  const { match, page } = standardSavedRound();
  let state = standardInitialState() as import("@tetraboard/shogi").ShogiState;
  const frames = [createShogiReplayFrame(state)];
  for (let offset = 0; offset < 12; offset += 5)
    for (const { event } of page(offset).events) {
      const next = applyShogiReplayEvent(state, event);
      if (!next.ok) throw Error(next.reason);
      state = next.state;
      frames.push(createShogiReplayFrame(state, event));
    }
  const view = render(wrap()(<ShogiMatchReplayView match={match} frames={frames} />));
  expect(view.querySelectorAll('[data-testid="player-card"]')).toHaveLength(2);
  expect(view.querySelector('[data-board-position="bottom"]')!.textContent).toContain("north");
  const board = view.querySelector('[aria-label="将棋の盤面"]')!;
  expect(board.querySelector("button")!.getAttribute("data-square")).toBe("I9");
  act(() =>
    view.querySelector<HTMLButtonElement>('[aria-label="盤面を時計回りに180度回転"]')!.click(),
  );
  expect(board.querySelector("button")!.getAttribute("data-square")).toBe("A1");
  expect(board.querySelectorAll("button:enabled")).toHaveLength(0);
  expect(view.textContent).not.toContain("シングルス");
});
test("入玉宣言の確認中に局revisionが変わったら確認を閉じ、次の局面へ持ち越さない", async () => {
  const room = standardPlayingRoom();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<ShogiRoomDetail {...options(room)} invited={false} />));
  const socket = connect(room);
  press(view, "入玉宣言");
  await flush();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  socket.snapshot({ ...room, positionRevision: 1 });
  await flush();
  clock.advance(300);
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(socket.sent.filter((m) => m.type === "room.game.declare")).toHaveLength(0);
});
