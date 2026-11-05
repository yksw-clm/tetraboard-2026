import { afterEach, expect, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInitialState, getLegalActions } from "@tetraboard/four-shogi";
import { FourShogiBoardLayout, type FourShogiBoardLayoutProps } from "../src/FourShogiBoardLayout";
import type { FourShogiAction } from "../src/shogiUiTypes";

const mounted: { root: Root; container: HTMLDivElement }[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) {
    act(() => view.root.unmount());
    view.container.remove();
  }
});
function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(node));
  return {
    container,
    rerender(next: ReactNode) {
      act(() => root.render(next));
    },
  };
}
function props(
  onAction: (action: FourShogiAction) => void,
): FourShogiBoardLayoutProps<FourShogiAction> {
  const initial = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
    threePlayerAttackProhibited: false,
  });
  const board = initial.board.map((row) =>
    row.map((piece) => (piece?.kind === "king" ? piece : null)),
  );
  board[3][4] = { id: 100, side: "south", kind: "rook", promoted: false };
  const state = {
    ...initial,
    status: "playing" as const,
    result: null,
    turn: "south" as const,
    board,
    hands: { ...initial.hands, south: { ...initial.hands.south, gold: 1 } },
    nextPieceId: 101,
  };
  return {
    game: state,
    viewerSide: "west",
    interactionSide: "south",
    revision: "first",
    canPlay: true,
    legalActions: getLegalActions(state),
    playerCards: {},
    onAction,
  };
}
const plainMove: FourShogiAction = {
  type: "movePiece",
  from: { x: 4, y: 3 },
  to: { x: 4, y: 2 },
  promote: false,
};
const square = (view: HTMLElement, name: string) =>
  view.querySelector<HTMLButtonElement>(`[data-square="${name}"]`)!;

test("閲覧方向が異なっても操作陣営の持ち駒を打ち、成り選択も駒の向きにそろえる", () => {
  const sent: FourShogiAction[] = [];
  const input = props((action) => {
    sent.push(action);
  });
  const view = render(<FourShogiBoardLayout {...input} />);
  act(() => square(view.container, "E4").click());
  act(() => square(view.container, "E3").click());
  const menu = document.querySelector<HTMLElement>('[aria-label="成りの選択"]')!;
  expect(menu).not.toBeNull();
  for (const image of menu.querySelectorAll("img"))
    expect(image.getAttribute("data-piece-direction")).toBe("left");
  expect(sent).toHaveLength(0);
  act(() => menu.querySelector<HTMLButtonElement>('[aria-label="成らない"]')!.click());
  expect(sent).toEqual([plainMove]);
  view.rerender(<FourShogiBoardLayout {...input} revision="next" />);
  const drop = input.legalActions.find((action) => action.type === "dropPiece")!;
  expect(drop.type).toBe("dropPiece");
  const gold = view.container.querySelector<HTMLButtonElement>(
    'button[aria-label^="南の持ち駒"][data-hand-kind="gold"]',
  )!;
  expect(gold.disabled).toBe(false);
  act(() => gold.click());
  act(() => square(view.container, `${"ABCDEFGHI"[drop.to.x]}${drop.to.y + 1}`).click());
  expect(sent).toEqual([plainMove, drop]);
});

test("局面を切り替えて元へ戻っても以前の成り選択を再表示しない", () => {
  const sent: FourShogiAction[] = [];
  const input = props((action) => {
    sent.push(action);
  });
  const view = render(<FourShogiBoardLayout {...input} />);
  act(() => square(view.container, "E4").click());
  act(() => square(view.container, "E3").click());
  expect(document.querySelector('[aria-label="成りの選択"]')).not.toBeNull();
  view.rerender(<FourShogiBoardLayout {...input} revision="other-position" />);
  expect(document.querySelector('[aria-label="成りの選択"]') === null).toBe(true);
  view.rerender(<FourShogiBoardLayout {...input} />);
  expect(document.querySelector('[aria-label="成りの選択"]') === null).toBe(true);
  expect(sent).toEqual([]);
});

test("ドラッグは回転後にポインター直下のマスへ着手し、盤の余白や盤外では送信しない", () => {
  const sent: FourShogiAction[] = [];
  const input = props((action) => {
    sent.push(action);
  });
  const view = render(<FourShogiBoardLayout {...input} />);
  const hitTest = spyOn(document, "elementFromPoint");
  const capture = spyOn(window.HTMLElement.prototype, "setPointerCapture").mockImplementation(
    () => {},
  );
  function dragTo(target: Element | null) {
    hitTest.mockReturnValue(target);
    const source = square(view.container, "E4");
    act(() => {
      for (const [type, clientX] of [
        ["pointerdown", 10],
        ["pointermove", 20],
        ["pointerup", 30],
      ] as const) {
        source.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            isPrimary: true,
            button: 0,
            clientX,
            clientY: 50,
            bubbles: true,
          }),
        );
      }
    });
  }
  try {
    dragTo(view.container.querySelector('[data-testid="shogi-board"]'));
    dragTo(null);
    expect(sent).toEqual([]);

    for (const viewerSide of ["south", "west", "north", "east"] as const) {
      view.rerender(
        <FourShogiBoardLayout {...input} viewerSide={viewerSide} revision={viewerSide} />,
      );
      dragTo(square(view.container, "E5").firstElementChild);
      expect(hitTest).toHaveBeenLastCalledWith(30, 50);
    }
    expect(sent).toEqual(Array.from({ length: 4 }, () => ({ ...plainMove, to: { x: 4, y: 4 } })));
  } finally {
    capture.mockRestore();
    hitTest.mockRestore();
  }
});

test("成り選択は移動先ボタンの中心とゲームごとの駒幅に合わせ、盤端では内側に寄る", () => {
  const input = props(() => {});
  for (const standard of [false, true]) {
    const view = render(<FourShogiBoardLayout {...input} viewerSide="north" standard={standard} />);
    const target = square(view.container, "E3");
    const board = spyOn(target.parentElement!, "getBoundingClientRect").mockReturnValue(
      new window.DOMRect(100, 50, 360, 360),
    );
    const bounds = spyOn(target, "getBoundingClientRect").mockReturnValue(
      new window.DOMRect(208, 168, 39.5, 40.5),
    );
    try {
      act(() => square(view.container, "E4").click());
      act(() => target.click());
      const menu = document.querySelector<HTMLElement>('[aria-label="成りの選択"]')!;
      const pieceWidth = 40 * (standard ? 0.86 : 0.82);
      const width = 2 * (pieceWidth + 8) + 4;
      const height = (pieceWidth * 148) / 140 + 8;
      expect(Number.parseFloat(menu.style.getPropertyValue("--shogi-piece-width"))).toBeCloseTo(
        pieceWidth,
      );
      expect(Number.parseFloat(menu.style.left) + width / 2).toBeCloseTo(208 + 39.5 / 2);
      expect(Number.parseFloat(menu.style.top) + height / 2).toBeCloseTo(168 + 40.5 / 2);

      bounds.mockReturnValue(new window.DOMRect(420, 370, 40, 40));
      act(() => window.dispatchEvent(new Event("resize")));
      expect(Number.parseFloat(menu.style.left) + width).toBeCloseTo(460);
      expect(Number.parseFloat(menu.style.top) + height).toBeCloseTo(410);
      view.rerender(null);
    } finally {
      bounds.mockRestore();
      board.mockRestore();
    }
  }
});

test("自由編集のマス選択から対局の着手を送信しない", () => {
  const sent: FourShogiAction[] = [];
  const selected: string[] = [];
  const input = props((action) => {
    sent.push(action);
  });
  const view = render(
    <FourShogiBoardLayout
      {...input}
      editing={{
        selected: null,
        onSelect: (position) => {
          selected.push(`${position.x}:${position.y}`);
        },
      }}
    />,
  );
  act(() => {
    square(view.container, "E4").click();
    square(view.container, "A1").click();
  });
  expect(selected).toEqual(["4:3", "0:0"]);
  expect(sent).toEqual([]);
  expect(document.querySelector('[aria-label="成りの選択"]')).toBeNull();
});
