import { beforeEach, afterEach, expect, test } from "bun:test";
import { createInitialState, applyAction } from "@tetraboard/gomoku";
import {
  gomokuRoomSchema,
  publicGomokuMatchDetailSchema,
  roomTimeControl,
} from "@tetraboard/protocol";
import archive from "../../../test-fixtures/matches/gomoku-on-five.json";
import GomokuRoomDetail from "../src/features/room/GomokuRoomDetail";
import GomokuMatchReplayView from "../src/features/room/GomokuMatchReplayView";
import { useGomokuSession } from "../src/features/room/useGomokuSession";
import { GomokuBoard } from "../src/features/room/GomokuBoard";
import { gomokuReplayFrames } from "../src/features/room/gomokuReplay";
import { HowToPlayDialog } from "../src/features/lobby/HowToPlayDialog";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import { waitingRoom, membership, token, now, playerIds } from "../test/fixtures/rooms";
import { act, clock, flush, press, render, renderHook, wrap } from "./harness";
import { installSocket, Socket } from "./socket";
let restore: () => void;
beforeEach(() => {
  restore = installSocket();
});
afterEach(() => restore());
function waiting() {
  const room = waitingRoom();
  return gomokuRoomSchema.parse({
    ...room,
    settings: { game: "gomoku", timeControl: roomTimeControl, forbiddenRules: true },
    players: room.players.slice(0, 2),
    roundId: null,
    positionRevision: 0,
  });
}
function playing() {
  const room = waiting();
  return gomokuRoomSchema.parse({
    ...room,
    status: "playing",
    roundId: archive.detail.id,
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
  act(() => {
    socket.open();
    socket.snapshot(room);
    socket.receive({ type: "room.authenticated", membership });
  });
  return socket;
}

test("待機中は空盤と上下2カード、紫テーマで禁手設定を表示する", async () => {
  const room = waiting();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<GomokuRoomDetail {...options(room)} invited={false} />));
  connect(room);
  expect(view.querySelectorAll('[data-testid="player-card"]')).toHaveLength(2);
  expect(view.querySelectorAll('[aria-label="五目並べの盤面"] button:enabled')).toHaveLength(0);
  expect(view.querySelector(".game-theme-gomoku")).not.toBeNull();
  press(view, "ルーム設定");
  await flush();
  clock.advance(300);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("禁手ルール");
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain("シングルス");
});
test("交点を一度押すと局ID付きで着手し、二重送信を抑止する", () => {
  const room = playing();
  if (room.status !== "playing") throw Error("not playing");
  saveRoomMembershipToken(room.id, token);
  const h = renderHook(useGomokuSession, options(room), wrap());
  const socket = connect(room);
  act(() => {
    h.current.handlePlaceStone({ x: 14, y: 14 });
    h.current.handlePlaceStone({ x: 14, y: 14 });
  });
  expect(socket.sent.filter((m) => m.type === "room.game.action")).toEqual([
    {
      type: "room.game.action",
      action: { type: "placeGomokuStone", position: { x: 14, y: 14 } },
      roundId: room.roundId,
      positionRevision: 0,
    },
  ]);
  const moved = applyAction(room.game, { type: "placeStone", position: { x: 14, y: 14 } });
  if (!moved.ok) throw Error("invalid");
  socket.snapshot(gomokuRoomSchema.parse({ ...room, game: moved.state, positionRevision: 1 }));
  expect(h.current.pendingGameAction).toBeNull();
  expect(h.current.canPlay).toBe(false);
});
test("禁手の交点は押せて本人だけに3秒toastを表示し、重複と送信を抑止する", async () => {
  const room = playing();
  if (room.status !== "playing") throw Error("not playing");
  for (const [x, y] of [
    [6, 7],
    [8, 7],
    [7, 6],
    [7, 8],
  ])
    room.game.board[y][x] = "black";
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<GomokuRoomDetail {...options(room)} invited={false} />));
  const socket = connect(room);
  const point = view.querySelector<HTMLButtonElement>('[aria-label="H8 空点"]')!;
  expect(point.disabled).toBe(false);
  act(() => {
    point.click();
    point.click();
  });
  await flush();
  expect(document.body.textContent).toContain("三三の反則になるため、ここには打てません。");
  expect(socket.sent.filter((m) => m.type === "room.game.action")).toHaveLength(0);
  expect(
    document.body.textContent!.split("三三の反則になるため、ここには打てません。"),
  ).toHaveLength(2);
  act(() => clock.advance(2999));
  expect(document.body.textContent).toContain("三三の反則");
  act(() => clock.advance(1001));
  await flush();
  expect(document.body.textContent).not.toContain("三三の反則");
});
test("保存棋譜の回転と固定座標、巻戻し時に未来の勝利を表示しない", () => {
  const detail = publicGomokuMatchDetailSchema.parse(archive.detail);
  const lastRound = {
    settings: detail.settings,
    game: detail.game,
    replay: detail.replay,
    players: detail.participants,
  };
  const frames = gomokuReplayFrames(lastRound);
  expect(frames[1].label).toBe("1: 黒 A8");
  expect(frames.at(-1)?.game.result?.winningLines[0]).toHaveLength(5);
  const view = render(
    wrap()(
      <GomokuMatchReplayView match={{ ...detail, selfPlayerId: detail.participants[1].id }} />,
    ),
  );
  const board = view.querySelector('[aria-label="五目並べの盤面"]')!;
  expect(board.querySelector("button")?.getAttribute("aria-label")).toStartWith("A1");
  act(() =>
    view.querySelector<HTMLButtonElement>('[aria-label="盤面を時計回りに180度回転"]')!.click(),
  );
  expect(board.querySelector("button")?.getAttribute("aria-label")).toStartWith("O15");
  expect(view.textContent).toContain("禁手ルール：ON");
  const earlier = render(
    <GomokuBoard game={frames[3].game} canPlay={false} onPlaceStone={() => {}} />,
  );
  expect(earlier.querySelectorAll('[stroke="#7c3aed"]')).toHaveLength(0);
  expect(board.querySelectorAll('[stroke="#7c3aed"]')).toHaveLength(5);
});
test("遊び方は禁手拒否・合法手なし・CPU1人を案内する", () => {
  render(wrap()(<HowToPlayDialog game="gomoku" onClose={() => {}} />));
  expect(document.body.textContent).toContain("黒の合法手がなくなれば白の勝ち");
  expect(document.body.textContent).toContain("CPU1人");
});

test("サーバーが禁手を拒否した場合も着手待ちを解き、理由付きtoastを本人へ表示する", async () => {
  const room = playing();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<GomokuRoomDetail {...options(room)} invited={false} />));
  const socket = connect(room);
  const point = view.querySelector<HTMLButtonElement>('[aria-label="H8 空点"]')!;
  act(() => point.click());
  expect(socket.sent.filter((m) => m.type === "room.game.action")).toHaveLength(1);
  act(() => socket.receive({ type: "room.error", error: "gomoku_double_four_overline" }));
  await flush();
  expect(document.body.textContent).toContain("四四・長連の反則になるため、ここには打てません。");
  expect(point.disabled).toBe(false);
  expect(point.getAttribute("aria-label")).toBe("H8 空点");
});

test("観戦者と手番外の対局者は着手を送信しない", () => {
  for (const participant of [null, { ...membership, playerId: playerIds[1] }]) {
    const room = playing();
    const h = renderHook(
      useGomokuSession,
      { ...options(room), initialMembership: participant },
      wrap(),
    );
    const socket = Socket.instances.at(-1)!;
    act(() => {
      socket.open();
      socket.snapshot(room);
    });
    if (participant)
      act(() => socket.receive({ type: "room.authenticated", membership: participant }));
    expect(h.current.canPlay).toBe(false);
    act(() => h.current.handlePlaceStone({ x: 7, y: 7 }));
    expect(socket.sent.filter((m) => m.type === "room.game.action")).toHaveLength(0);
  }
});
