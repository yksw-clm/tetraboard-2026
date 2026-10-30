import { afterEach, expect, test } from "bun:test";
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

for (const [viewerSide, coordinates] of [
  ["south", [4.5, 3.5, 4.5, 2.5]],
  ["west", [3.5, 4.5, 2.5, 4.5]],
  ["north", [4.5, 5.5, 4.5, 6.5]],
  ["east", [5.5, 4.5, 6.5, 4.5]],
] as const) {
  test(`最善手の矢印を9×9操作gridに重ねて回転する: ${viewerSide}`, () => {
    const input = props(() => {});
    const view = render(
      <FourShogiBoardLayout
        {...input}
        viewerSide={viewerSide}
        bestMove={{ action: plainMove, label: "暫定最善手・深さ1まで完成" }}
      />,
    );
    const overlay = view.container.querySelector<SVGSVGElement>('[data-testid="shogi-best-move"]')!;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute("viewBox")).toBe("0 0 9 9");
    expect(overlay.getAttribute("preserveAspectRatio")).toBe("none");
    expect(overlay.style.pointerEvents).toBe("none");
    expect(overlay.parentElement!.querySelectorAll(":scope > button[data-square]")).toHaveLength(
      81,
    );
    const line = overlay.querySelector("line")!;
    expect(["x1", "y1", "x2", "y2"].map((key) => Number(line.getAttribute(key)))).toEqual([
      ...coordinates,
    ]);
  });
}

test("最善手は成り/不成と駒打ちを区別し、盤上操作を維持する", () => {
  const sent: FourShogiAction[] = [];
  const input = props((action) => sent.push(action));
  const view = render(<FourShogiBoardLayout {...input} />);
  expect(view.container.querySelector('[data-testid="shogi-best-move"]')).toBeNull();
  view.rerender(
    <FourShogiBoardLayout {...input} bestMove={{ action: plainMove, label: "暫定最善手" }} />,
  );
  expect(view.container.querySelector('[data-testid="shogi-best-move"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="shogi-best-move"]')!.textContent).toContain(
    "不成",
  );
  act(() => square(view.container, "E4").click());
  act(() => square(view.container, "E3").click());
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="成らない"]')!.click());
  expect(sent).toEqual([plainMove]);
  view.rerender(
    <FourShogiBoardLayout
      {...input}
      bestMove={{ action: { ...plainMove, promote: true }, label: "最善手（探索完了）" }}
    />,
  );
  expect(view.container.querySelector('[data-testid="shogi-best-move"]')!.textContent).toContain(
    "成",
  );
  expect(
    view.container.querySelector('[data-testid="shogi-best-move"]')!.textContent,
  ).not.toContain("不成");
  const drop = input.legalActions.find((action) => action.type === "dropPiece")!;
  view.rerender(
    <FourShogiBoardLayout
      {...input}
      revision="drop"
      bestMove={{ action: drop, label: "最善手（探索完了）" }}
    />,
  );
  const overlay = view.container.querySelector('[data-testid="shogi-best-move"]')!;
  expect(overlay.querySelector("line")).toBeNull();
  expect(overlay.querySelector("circle")).not.toBeNull();
  expect(overlay.textContent).toContain("金打");
  act(() =>
    view.container.querySelector<HTMLButtonElement>('button[data-hand-kind="gold"]')!.click(),
  );
  act(() => square(view.container, `${"ABCDEFGHI"[drop.to.x]}${drop.to.y + 1}`).click());
  expect(sent).toEqual([plainMove, drop]);
});

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
