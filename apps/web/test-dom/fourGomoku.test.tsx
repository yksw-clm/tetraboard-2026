import { beforeEach, afterEach, expect, test } from "bun:test";
import { createInitialState, applyAction, colors } from "@tetraboard/four-gomoku";
import {
  fourGomokuRoomSchema,
  fourGomokuMatchDetailSchema,
  roomTimeControl,
} from "@tetraboard/protocol";
import archive from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import FourGomokuRoomDetail from "../src/features/room/FourGomokuRoomDetail";
import FourGomokuMatchReplayView from "../src/features/room/FourGomokuMatchReplayView";
import { useFourGomokuSession } from "../src/features/room/useFourGomokuSession";
import { GomokuBoard } from "../src/features/room/GomokuBoard";
import { fourGomokuReplayFrames } from "../src/features/room/fourGomokuReplay";
import { FourGomokuPlayerCard } from "../src/features/room/FourGomokuPlayerCard";
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
  return fourGomokuRoomSchema.parse({
    ...waitingRoom(),
    settings: { game: "four-gomoku", mode: "singles", timeControl: roomTimeControl },
    roundId: null,
    positionRevision: 0,
  });
}
function playing() {
  const room = waiting();
  return fourGomokuRoomSchema.parse({
    ...room,
    status: "playing",
    roundId: archive.detail.id,
    players: room.players.map((p, i) => ({ ...p, color: colors[i] })),
    game: createInitialState(),
    clock: {
      remainingMainMs: { black: 300000, white: 300000, red: 300000, blue: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
}
const options = (room: ReturnType<typeof waiting>) => ({
  initialRoom: room,
  initialMembership: membership,
  initialServerNowMs: now,
  initialPresence: { hostPlayerId: playerIds[0], connectedPlayerIds: playerIds },
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
test("四人のカード・紫テーマ・モード設定・禁手なし", async () => {
  const room = waiting();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<FourGomokuRoomDetail {...options(room)} invited={false} />));
  connect(room);
  expect(view.querySelectorAll('[data-testid="player-card"]')).toHaveLength(4);
  expect(view.querySelector(".game-theme-gomoku")).not.toBeNull();
  expect(view.querySelectorAll('[aria-label="四人五目並べの盤面"] button:enabled')).toHaveLength(0);
  press(view, "ルーム設定");
  await flush();
  clock.advance(300);
  expect(document.body.textContent).toContain("シングルス");
  expect(document.body.textContent).not.toContain("禁手ルール");
});
test("交点1回でrevision付き着手、二重送信・手番外を抑止", () => {
  const room = playing();
  if (room.status !== "playing") throw Error();
  saveRoomMembershipToken(room.id, token);
  const h = renderHook(useFourGomokuSession, options(room), wrap());
  const socket = connect(room);
  act(() => {
    h.current.handlePlaceStone({ x: 14, y: 14 });
    h.current.handlePlaceStone({ x: 14, y: 14 });
  });
  expect(socket.sent.filter((m) => m.type === "room.game.action")).toEqual([
    {
      type: "room.game.action",
      action: { type: "placeFourGomokuStone", position: { x: 14, y: 14 } },
      roundId: room.roundId,
      positionRevision: 0,
    },
  ]);
  const next = applyAction(room.game, { type: "placeStone", position: { x: 14, y: 14 } });
  if (!next.ok) throw Error();
  act(() =>
    socket.snapshot(fourGomokuRoomSchema.parse({ ...room, game: next.state, positionRevision: 1 })),
  );
  expect(h.current.canPlay).toBe(false);
  expect(h.current.pendingGameAction).toBeNull();
});
test("勝ち抜けの順位と時計停止、観戦継続中に着手・投了を送信しない", () => {
  const room = playing();
  if (room.status !== "playing") throw Error();
  const detail = fourGomokuMatchDetailSchema.parse(archive.detail);
  const partial = detail.replay.steps[16].game;
  const updated = fourGomokuRoomSchema.parse({ ...room, game: partial, positionRevision: 17 });
  saveRoomMembershipToken(room.id, token);
  const h = renderHook(useFourGomokuSession, options(updated), wrap());
  const socket = connect(updated);
  expect(h.current.canPlay).toBe(false);
  act(() => {
    h.current.handleResignClick();
    h.current.handlePlaceStone({ x: 7, y: 7 });
  });
  expect(
    socket.sent.filter((m) => typeof m.type === "string" && m.type.startsWith("room.game.")),
  ).toHaveLength(0);
  const view = render(
    wrap()(
      <FourGomokuPlayerCard
        player={updated.players[0]}
        position="bottom"
        self
        host
        room={updated}
        now={now}
      />,
    ),
  );
  expect(view.textContent).toContain("1位（五連完成）");
  expect(view.textContent).not.toContain("5:00");
});
test("保存棋譜は90度回転、全ての石色・座標を保持し、巻戻しで未来の順位と完成線を隠す", () => {
  const detail = fourGomokuMatchDetailSchema.parse(archive.detail);
  const frames = fourGomokuReplayFrames({
    settings: detail.settings,
    game: detail.game,
    replay: detail.replay,
    players: detail.participants,
  });
  expect(frames[1].label).toBe("1: 黒 A1");
  expect(frames[16].game.standings).toEqual([]);
  expect(frames[17].game.standings).toHaveLength(1);
  const view = render(wrap()(<FourGomokuMatchReplayView match={detail} />));
  const board = view.querySelector('[aria-label="四人五目並べの盤面"]')!;
  expect(board.querySelector("button")?.getAttribute("aria-label")).toStartWith("A1");
  act(() =>
    view.querySelector<HTMLButtonElement>('[aria-label="盤面を時計回りに90度回転"]')!.click(),
  );
  expect(board.querySelector("button")?.getAttribute("aria-label")).toStartWith("A15");
  expect(board.querySelectorAll('[stroke="#7c3aed"]')).toHaveLength(15);
  expect(board.querySelector('[aria-label="A5 赤"]')).not.toBeNull();
  expect(board.querySelector('[aria-label="A7 青"]')).not.toBeNull();
  const earlier = render(
    <GomokuBoard game={frames[16].game} canPlay={false} onPlaceStone={() => {}} />,
  );
  expect(earlier.querySelectorAll('[stroke="#7c3aed"]')).toHaveLength(0);
});
test("90度回転後の入力を元の座標へ戻す", () => {
  let move: unknown;
  const view = render(
    <GomokuBoard
      game={createInitialState()}
      rotation={1}
      canPlay
      onPlaceStone={(p) => {
        move = p;
      }}
    />,
  );
  act(() => view.querySelector<HTMLButtonElement>("button")!.click());
  expect(move).toEqual({ x: 0, y: 14 });
});
test("遊び方は順位・残石・混色とCPU3人を案内", () => {
  render(wrap()(<HowToPlayDialog game="four-gomoku" onClose={() => {}} />));
  for (const text of ["勝ち抜け", "味方2色", "CPU3人", "禁手はありません"])
    expect(document.body.textContent).toContain(text);
});

test("途中の勝ち抜けでは結果を自動表示せず、退室しても確定順位を保つ案内を出す", async () => {
  const room = playing();
  saveRoomMembershipToken(room.id, token);
  const view = render(wrap()(<FourGomokuRoomDetail {...options(room)} invited={false} />));
  const socket = connect(room);
  const detail = fourGomokuMatchDetailSchema.parse(archive.detail);
  const updated = fourGomokuRoomSchema.parse({
    ...room,
    game: detail.replay.steps[16].game,
    positionRevision: 17,
  });
  act(() => socket.snapshot(updated));
  act(() => clock.advance(1001));
  await flush();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(view.textContent).toContain("1位（五連完成）");
  press(view, "退室");
  await flush();
  act(() => clock.advance(300));
  expect(document.body.textContent).toContain("確定した順位は変わりません。");
});
