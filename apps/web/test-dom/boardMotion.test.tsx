import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import * as reversi from "@tetraboard/reversi";
import * as fourReversi from "@tetraboard/four-reversi";
import * as gomoku from "@tetraboard/gomoku";
import * as fourGomoku from "@tetraboard/four-gomoku";
import * as shogi from "@tetraboard/shogi";
import * as fourShogi from "@tetraboard/four-shogi";
import { FourReversiBoard } from "../src/features/room/FourReversiBoard";
import { GomokuBoard } from "../src/features/room/GomokuBoard";
import { FourShogiBoardLayout } from "../src/features/room/FourShogiBoardLayout";
import type { ShogiBoardView } from "../src/features/room/shogiBoardPresentation";
import { optimisticShogiBoard } from "../src/features/room/optimisticShogiBoard";
import { roomBoardMotion } from "../src/features/room/boardMotion";
import { browserSettings, browserSettingsKey } from "../src/shared/browserSettings";
import { playingRoom } from "../test/fixtures/rooms";
import {
  initialShogiState,
  tacticalShogiState,
  playingShogiRoom,
  finishedShogiRound,
} from "../test/fixtures/fourShogiFixtures";
import { act, render, rerender } from "./harness";

type Played = {
  element: Element;
  frames: Keyframe[];
  duration: number;
  cancel: ReturnType<typeof mock>;
};
let played: Played[];
let restoreAnimate: () => void;
let media: MediaQueryList;
let mediaMock: ReturnType<typeof spyOn>;
const motion = (moveNumber: number, scope = "round-1") => ({ scope, moveNumber });
beforeEach(() => {
  played = [];
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const cancel = mock(() => {});
      played.push({ element: this, frames, duration: Number(options.duration), cancel });
      return { cancel, onfinish: null, oncancel: null };
    },
  });
  restoreAnimate = () => {
    if (descriptor) Object.defineProperty(Element.prototype, "animate", descriptor);
    else Reflect.deleteProperty(Element.prototype, "animate");
  };
  media = window.matchMedia("(prefers-reduced-motion: reduce)");
  Object.defineProperty(media, "matches", { configurable: true, value: false });
  mediaMock = spyOn(window, "matchMedia").mockReturnValue(media);
});
afterEach(() => {
  act(() => browserSettings.update({ boardAnimationsEnabled: true }));
  restoreAnimate();
  mediaMock.mockRestore();
});

test("設定OFFで反転中も即時停止し、OFF中の着手を再演せずON後の新しい手から再開する", () => {
  const initial = reversi.createInitialState();
  const next = changed(
    reversi.applyAction(initial, {
      type: "placeStone",
      position: reversi.getLegalMoves(initial)[0]!,
    }),
  );
  const second = changed(
    reversi.applyAction(next, { type: "placeStone", position: reversi.getLegalMoves(next)[0]! }),
  );
  const third = changed(
    reversi.applyAction(second, {
      type: "placeStone",
      position: reversi.getLegalMoves(second)[0]!,
    }),
  );
  const board = (game: reversi.ReversiState) => (
    <FourReversiBoard
      game={game}
      motion={motion(game.moveNumber)}
      legalMoves={[]}
      canPlay={false}
      onPlaceStone={() => {}}
    />
  );
  const view = render(board(initial));
  rerender(view, board(next));
  expect(played.some((p) => p.duration === 220)).toBe(true);
  const firstCount = played.length;
  act(() => browserSettings.update({ boardAnimationsEnabled: false }));
  expect(played.every((p) => p.cancel.mock.calls.length === 1)).toBe(true);
  rerender(view, board(second));
  expect(played).toHaveLength(firstCount);
  act(() => browserSettings.update({ boardAnimationsEnabled: true }));
  expect(played).toHaveLength(firstCount);
  rerender(view, board(third));
  expect(played.length).toBeGreaterThan(firstCount);
});

test("保存済みOFFと別タブの変更を着地へ反映し、ONでもOSの動き低減設定を優先する", () => {
  act(() => browserSettings.update({ boardAnimationsEnabled: false }));
  const initial = gomoku.createInitialState();
  const next = changed(
    gomoku.applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } }),
  );
  const second = changed(
    gomoku.applyAction(next, { type: "placeStone", position: { x: 8, y: 7 } }),
  );
  const third = changed(
    gomoku.applyAction(second, { type: "placeStone", position: { x: 7, y: 8 } }),
  );
  const board = (game: gomoku.GomokuState) => (
    <GomokuBoard
      game={game}
      motion={motion(game.moveNumber)}
      canPlay={false}
      onPlaceStone={() => {}}
    />
  );
  const view = render(board(initial));
  rerender(view, board(next));
  expect(played).toHaveLength(0);
  const sync = (boardAnimationsEnabled: boolean) => {
    const value = JSON.stringify({ boardAnimationsEnabled });
    localStorage.setItem(browserSettingsKey, value);
    act(() =>
      window.dispatchEvent(
        new window.StorageEvent("storage", { key: browserSettingsKey, newValue: value }),
      ),
    );
  };
  sync(true);
  expect(played).toHaveLength(0);
  rerender(view, board(second));
  expect(played).toHaveLength(1);
  sync(false);
  expect(played[0]!.cancel).toHaveBeenCalledTimes(1);
  act(() => {
    Object.defineProperty(media, "matches", { configurable: true, value: true });
    media.dispatchEvent(new Event("change"));
  });
  sync(true);
  rerender(view, board(third));
  expect(played).toHaveLength(1);
});

function changed<T>(result: { ok: true; state: T } | { ok: false }): T {
  if (!result.ok) throw new Error("Invalid animation fixture move");
  return result.state;
}
const square = (play: Played) => play.element.getAttribute("data-board-piece");

for (const [name, fixture] of [
  [
    "リバーシ",
    () => {
      const initial = reversi.createInitialState();
      const position = reversi.getLegalMoves(initial)[0]!;
      return {
        initial,
        position,
        next: changed(reversi.applyAction(initial, { type: "placeStone", position })),
      };
    },
  ],
  [
    "四人リバーシ",
    () => {
      const initial = fourReversi.createInitialState("singles");
      const position = fourReversi.getLegalMoves(initial)[0]!;
      return {
        initial,
        position,
        next: changed(fourReversi.applyAction(initial, { type: "placeStone", position })),
      };
    },
  ],
] as const) {
  test(`${name}は初期配置を動かさず、置いた石を150ms、取った石を220msで演出する`, () => {
    // 各ルールの公開APIで合法な一手を作ります。
    const { initial, position, next } = fixture();
    const board = (game: typeof initial) => (
      <FourReversiBoard
        game={game}
        motion={motion(game.moveNumber)}
        legalMoves={[]}
        canPlay={false}
        onPlaceStone={() => {}}
      />
    );
    const view = render(board(initial));
    expect(played).toHaveLength(0);
    rerender(view, board(next));
    expect(played.filter((p) => p.duration === 150).map(square)).toEqual([
      `${position.x},${position.y}`,
    ]);
    const flipped = played.filter((p) => p.duration === 220);
    expect(flipped.length).toBeGreaterThan(0);
    for (const p of flipped) {
      const [x, y] = square(p)!.split(",").map(Number);
      expect(p.frames[0]!.backgroundImage).toBe(`var(--stone-${initial.board[y]![x]})`);
      expect(p.frames.at(-1)!.backgroundImage).toBe(`var(--stone-${next.board[y]![x]})`);
    }
    const count = played.length;
    rerender(view, board(structuredClone(next)));
    expect(played).toHaveLength(count);
    expect(played.every((p) => p.cancel.mock.calls.length === 0)).toBe(true);
    rerender(view, null);
    expect(played.every((p) => p.cancel.mock.calls.length === 1)).toBe(true);
  });
}

test("四人リバーシの白・赤・青を元の色から同時に220msで反転する", () => {
  const board: fourReversi.Cell[][] = Array.from({ length: 8 }, () => Array(8).fill(null));
  board[0] = ["black", "white", "red", "blue", null, null, null, null];
  board[7] = ["white", "red", "blue", null, null, null, null, null];
  const initial = { ...fourReversi.createInitialState("singles"), board };
  const next = changed(
    fourReversi.applyAction(initial, { type: "placeStone", position: { x: 4, y: 0 } }),
  );
  const component = (game: fourReversi.FourReversiState) => (
    <FourReversiBoard
      game={game}
      motion={motion(game.moveNumber)}
      legalMoves={[]}
      canPlay={false}
      onPlaceStone={() => {}}
    />
  );
  const view = render(component(initial));
  rerender(view, component(next));
  expect(played.map((p) => p.duration).sort()).toEqual([150, 220, 220, 220]);
  expect(played.filter((p) => p.duration === 220).map((p) => p.frames[0]!.backgroundImage)).toEqual(
    ["var(--stone-white)", "var(--stone-red)", "var(--stone-blue)"],
  );
  expect(view.querySelector('[aria-label^="B1：黒"]')).not.toBeNull();
});

for (const four of [false, true]) {
  test(`${four ? "四人五目並べ" : "五目並べ"}は着石を150msで表示し、演出完了前でも次の操作を受け付ける`, () => {
    const initial = four ? fourGomoku.createInitialState() : gomoku.createInitialState();
    const action = { type: "placeStone" as const, position: { x: 7, y: 7 } };
    const next = four
      ? changed(fourGomoku.applyAction(initial as fourGomoku.FourGomokuState, action))
      : changed(gomoku.applyAction(initial as gomoku.GomokuState, action));
    const onPlace = mock(() => {});
    const board = (game: typeof initial) => (
      <GomokuBoard game={game} motion={motion(game.moveNumber)} canPlay onPlaceStone={onPlace} />
    );
    const view = render(board(initial));
    expect(played).toHaveLength(0);
    rerender(view, board(next));
    expect(played.map((p) => [square(p), p.duration])).toEqual([["7,7", 150]]);
    const button = view.querySelector<HTMLButtonElement>('[aria-label="I8 空点"]')!;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(onPlace).toHaveBeenCalledWith({ x: 8, y: 7 });
    expect(played[0]!.cancel).not.toHaveBeenCalled();
  });
}

const shogiBoard = (
  game: ShogiBoardView,
  moveNumber: number,
  standard = false,
  pendingAction?: shogi.ShogiAction,
) => (
  <FourShogiBoardLayout
    game={game}
    motion={motion(moveNumber)}
    viewerSide="south"
    revision={moveNumber}
    canPlay={false}
    legalActions={[]}
    onAction={() => {}}
    playerCards={{}}
    standard={standard}
    pendingAction={pendingAction}
  />
);
for (const standard of [false, true]) {
  test(`${standard ? "将棋" : "四人将棋"}の先行表示を一度だけ着地させ、確定で再演しない`, () => {
    const { initial, action, confirmed } = standard
      ? (() => {
          const initial = shogi.createInitialState({ players: { south: "one", north: "two" } });
          const action = shogi.getLegalActions(initial)[0]!;
          return {
            initial,
            action,
            confirmed: changed(shogi.applyAction(initial, "south", action)),
          };
        })()
      : (() => {
          const initial = initialShogiState();
          const action = fourShogi.getLegalActions(initial)[0]!;
          return {
            initial,
            action,
            confirmed: changed(fourShogi.applyAction(initial, "south", action)),
          };
        })();
    const pending = optimisticShogiBoard(initial, "south", action);
    const view = render(shogiBoard(initial, 0, standard));
    expect(played).toHaveLength(0);
    rerender(view, shogiBoard(pending, 0, standard, action));
    expect(played.map((p) => [square(p), p.duration])).toEqual([
      [`${action.to.x},${action.to.y}`, 150],
    ]);
    const image = played[0]!.element.querySelector("img");
    rerender(view, shogiBoard(confirmed, 1, standard));
    expect(played).toHaveLength(1);
    expect(played[0]!.cancel).not.toHaveBeenCalled();
    expect(view.querySelector(`[data-board-piece="${action.to.x},${action.to.y}"] img`)).toBe(
      image,
    );
  });
}

test("将棋の捕獲・成り・駒打ちを着地させ、拒否による巻き戻しを演出しない", () => {
  const initial = tacticalShogiState();
  const actions: shogi.ShogiAction[] = [
    { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
    { type: "movePiece", from: { x: 3, y: 3 }, to: { x: 3, y: 2 }, promote: true },
    { type: "dropPiece", pieceKind: "gold", to: { x: 5, y: 5 } },
  ];
  for (const action of actions) {
    const pending = optimisticShogiBoard(initial, "south", action);
    const view = render(shogiBoard(initial, 0));
    const count = played.length;
    rerender(view, shogiBoard(pending, 0, false, action));
    expect(played).toHaveLength(count + 1);
    expect(square(played.at(-1)!)).toBe(`${action.to.x},${action.to.y}`);
    rerender(view, shogiBoard(initial, 0));
    expect(played).toHaveLength(count + 1);
    expect(played.at(-1)!.cancel).toHaveBeenCalledTimes(1);
    rerender(view, null);
  }
});

test("複数手の反映・回転・再戦・棋譜・再接続では再演せず、その後の新しい手を演出する", () => {
  const initial = gomoku.createInitialState();
  const next = changed(
    gomoku.applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } }),
  );
  const second = changed(
    gomoku.applyAction(next, { type: "placeStone", position: { x: 8, y: 7 } }),
  );
  const board = (
    game: gomoku.GomokuState,
    context = motion(game.moveNumber) as ReturnType<typeof motion> | null,
    rotation: 0 | 2 = 0,
  ) => (
    <GomokuBoard
      game={game}
      motion={context}
      rotation={rotation}
      canPlay={false}
      onPlaceStone={() => {}}
    />
  );
  const view = render(board(initial));
  rerender(view, board(second));
  rerender(view, board(second, motion(2), 2));
  rerender(view, board(initial, motion(0, "round-2")));
  rerender(view, board(next, null));
  rerender(view, board(initial, null));
  rerender(view, board(next, motion(1)));
  expect(played).toHaveLength(0);
  rerender(view, board(second));
  expect(played.map(square)).toEqual(["8,7"]);
});

test("動きを減らす設定の途中変更で停止し、抑制中の着手は後から再演しない", () => {
  const initial = gomoku.createInitialState();
  const next = changed(
    gomoku.applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } }),
  );
  const board = (game: gomoku.GomokuState) => (
    <GomokuBoard
      game={game}
      motion={motion(game.moveNumber)}
      canPlay={false}
      onPlaceStone={() => {}}
    />
  );
  const view = render(board(initial));
  rerender(view, board(next));
  expect(played).toHaveLength(1);
  act(() => {
    Object.defineProperty(media, "matches", { configurable: true, value: true });
    media.dispatchEvent(new Event("change"));
  });
  expect(played[0]!.cancel).toHaveBeenCalledTimes(1);
  rerender(view, board(initial));
  rerender(view, board(next));
  expect(played).toHaveLength(1);
  act(() => {
    Object.defineProperty(media, "matches", { configurable: true, value: false });
    media.dispatchEvent(new Event("change"));
  });
  rerender(view, board(next));
  expect(played).toHaveLength(1);
});

test("StrictModeでも初回表示を動かさず、非表示への切替で再生を停止する", () => {
  const initial = gomoku.createInitialState();
  const next = changed(
    gomoku.applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } }),
  );
  const board = (game: gomoku.GomokuState) => (
    <StrictMode>
      <GomokuBoard
        game={game}
        motion={motion(game.moveNumber)}
        canPlay={false}
        onPlaceStone={() => {}}
      />
    </StrictMode>
  );
  const view = render(board(initial));
  expect(played).toHaveLength(0);
  rerender(view, board(next));
  expect(played).toHaveLength(1);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(played[0]!.cancel).toHaveBeenCalledTimes(1);
  rerender(view, board(next));
  expect(played).toHaveLength(1);
});

test("切断中・未認証・対局中の棋譜では局の情報を渡さない", () => {
  const session = {
    room: playingRoom(),
    connection: "接続済み",
    authenticated: true,
    leaving: false,
    unavailable: null,
  };
  const replay = { frame: null, index: -1, frames: [] };
  expect(roomBoardMotion(session, replay)?.moveNumber).toBe(0);
  expect(roomBoardMotion({ ...session, connection: "再接続中" }, replay)).toBeNull();
  expect(roomBoardMotion({ ...session, authenticated: false }, replay)).toBeNull();
  expect(roomBoardMotion(session, { frame: {}, index: 0, frames: [{}] })).toBeNull();
});

test("終局直後の最終局面は対局中と同じ局として扱い、棋譜の途中は対象にしない", () => {
  const { room: finished } = finishedShogiRound();
  const session = {
    room: playingShogiRoom(),
    connection: "接続済み",
    authenticated: true,
    leaving: false,
    unavailable: null,
  };
  const live = roomBoardMotion(session, { frame: null, index: -1, frames: [] });
  const final = roomBoardMotion(
    { ...session, room: finished },
    {
      frame: {},
      index: 1,
      frames: [{}, {}],
    },
  );
  expect(final?.scope).toBe(live?.scope);
  expect(final?.moveNumber).toBe(1);
  expect(
    roomBoardMotion(
      { ...session, room: finished },
      {
        frame: {},
        index: 0,
        frames: [{}, {}],
      },
    ),
  ).toBeNull();
});
