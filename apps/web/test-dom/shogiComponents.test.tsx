import { expect, spyOn, test } from "bun:test";
import { type FourShogiAction } from "@tetraboard/four-shogi";
import { ShogiPiece } from "../src/features/room/ShogiPiece";
import { prepareShogiPieceImages, shogiPieceImage } from "../src/features/room/shogiPieceImages";
import {
  FourShogiBoardLayout,
  type FourShogiBoardLayoutProps,
} from "../src/features/room/FourShogiBoardLayout";
import { FourShogiLobbyBoardPreview } from "../src/features/lobby/FourShogiLobbyBoardPreview";
import { playingShogiRoom, tacticalShogiState } from "../test/fixtures/fourShogiFixtures";
import { act, flush, render, rerender } from "./harness";

test("希少画像は6URL・2並列・低優先で先読みし、失敗もcacheして二度取得しない", async () => {
  const pending: { image: HTMLImageElement; finish: () => void; reject: () => void }[] = [];
  const decode = spyOn(window.HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return new Promise<void>((resolve, reject) =>
      pending.push({ image: this, finish: resolve, reject: () => reject(new Error("failure")) }),
    );
  });
  try {
    const first = prepareShogiPieceImages();
    expect(prepareShogiPieceImages()).toBe(first);
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.image.fetchPriority === "low")).toBe(true);
    pending[0]!.finish();
    await flush();
    expect(pending).toHaveLength(3);
    pending[1]!.finish();
    await flush();
    expect(pending).toHaveLength(4);
    pending[2]!.finish();
    pending[3]!.finish();
    await flush();
    expect(pending).toHaveLength(6);
    pending[4]!.reject();
    pending[5]!.finish();
    await first;
    expect(new Set(pending.map((p) => p.image.src)).size).toBe(6);
    await prepareShogiPieceImages();
    expect(pending).toHaveLength(6);
  } finally {
    decode.mockRestore();
  }
});
test("駒名・方向・srcとdecode待ちのfallback、古い非同期完了の破棄を検証", async () => {
  const pending: { image: HTMLImageElement; finish: () => void; reject: () => void }[] = [];
  const decode = spyOn(window.HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return new Promise<void>((resolve, reject) =>
      pending.push({
        image: this,
        finish: resolve,
        reject: () => reject(new Error("decode failure")),
      }),
    );
  });
  try {
    const view = render(<ShogiPiece kind="silver" promoted direction="right" />);
    expect(view.textContent).toBe("成銀");
    expect(view.querySelector("img")!.getAttribute("data-piece-direction")).toBe("right");
    expect(view.querySelector("img")!.getAttribute("src")).toBe(
      shogiPieceImage("silver", true, false, "right").src,
    );
    rerender(view, <ShogiPiece kind="king" deadKing direction="down" />);
    expect(view.textContent).toBe("裏王");
    Object.defineProperty(pending[0]!.image, "complete", { value: true });
    Object.defineProperty(pending[0]!.image, "naturalWidth", { value: 140 });
    pending[0]!.finish();
    await flush();
    expect(view.textContent).toBe("裏王");
    pending[1]!.reject();
    await flush();
    expect(view.textContent).toBe("裏王");
    rerender(view, <ShogiPiece kind="rook" promoted direction="left" />);
    expect(view.textContent).toBe("龍");
    Object.defineProperty(pending[2]!.image, "complete", { value: true });
    Object.defineProperty(pending[2]!.image, "naturalWidth", { value: 140 });
    pending[2]!.finish();
    await flush();
    expect(view.textContent).toBe("");
  } finally {
    decode.mockRestore();
  }
});
function boardProps(onAction: (action: FourShogiAction) => boolean): FourShogiBoardLayoutProps {
  const room = playingShogiRoom(tacticalShogiState());
  return {
    game: room.game,
    viewerSide: "south",
    revision: "r:0",
    canPlay: true,
    legalActions: room.legalActions,
    threePlayerAttackForbiddenActions: room.threePlayerAttackForbiddenActions,
    onAction,
    playerCards: { south: "南", west: "西", north: "北", east: "東" },
    promotionContext: {
      instanceId: room.instanceId,
      playerId: room.players[0]!.id,
      roundId: room.roundId,
      positionRevision: 0,
      side: "south",
      confirmed: true,
    },
  };
}
const square = (view: HTMLElement, x: number, y: number) =>
  view.querySelector<HTMLButtonElement>(`[data-square="${"ABCDEFGHI"[x]}${y + 1}"]`)!;

test("まとめた戦型名を控えめに読み上げ、選択操作で表示を解除する", () => {
  const props = boardProps(() => true);
  const view = render(<FourShogiBoardLayout {...props} formationNotice="地下鉄飛車・下段金寄せ" />);
  const notice = view.querySelector('[data-testid="shogi-formation-notice"]')!;
  expect(notice.textContent).toBe("地下鉄飛車・下段金寄せ");
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.getAttribute("aria-live")).toBe("polite");
  act(() => square(view, 4, 6).click());
  expect(view.querySelector('[data-testid="shogi-formation-notice"]')).toBeNull();
});

test("将棋盤の選択・捕獲候補・revision解除・不正操作抑止・一度だけの送信", () => {
  const sent: FourShogiAction[] = [];
  const props = boardProps((action) => {
    sent.push(action);
    return true;
  });
  const view = render(<FourShogiBoardLayout {...props} />);
  act(() => square(view, 4, 6).click());
  expect(square(view, 4, 6).getAttribute("aria-pressed")).toBe("true");
  act(() => square(view, 4, 6).click());
  expect(square(view, 4, 6).getAttribute("aria-pressed")).toBe("false");
  act(() => square(view, 4, 6).click());
  rerender(view, <FourShogiBoardLayout {...props} revision="r:1" />);
  expect(square(view, 4, 6).getAttribute("aria-pressed")).toBe("false");
  act(() => square(view, 4, 5).click());
  expect(sent).toHaveLength(0);
  act(() => square(view, 4, 6).click());
  act(() => square(view, 4, 5).click());
  expect(sent).toEqual([
    { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
  ]);
  act(() => {
    square(view, 4, 6).click();
    square(view, 4, 5).click();
  });
  expect(sent).toHaveLength(1);
  rerender(view, <FourShogiBoardLayout {...props} canPlay={false} revision="r:2" />);
  act(() => square(view, 4, 6).click());
  expect(sent).toHaveLength(1);
  expect(view.querySelectorAll("[data-side]")).toHaveLength(4);
});
test("成りメニューは選択まで送信せず、取消・不成・選択外の成りを一度だけ確定", () => {
  for (const choice of ["Escape", "成らない", "成りを確定"]) {
    const sent: FourShogiAction[] = [];
    const props = boardProps((action) => {
      sent.push(action);
      return true;
    });
    const view = render(<FourShogiBoardLayout {...props} />);
    const candidate = props.legalActions.find(
      (a) =>
        a.type === "movePiece" &&
        a.promote &&
        props.legalActions.some(
          (b) =>
            b.type === "movePiece" &&
            !b.promote &&
            JSON.stringify(b.from) === JSON.stringify(a.from) &&
            JSON.stringify(b.to) === JSON.stringify(a.to),
        ),
    );
    if (!candidate || candidate.type !== "movePiece") throw new Error("promotion fixture");
    act(() => square(view, candidate.from.x, candidate.from.y).click());
    act(() => square(view, candidate.to.x, candidate.to.y).click());
    expect(sent).toHaveLength(0);
    expect(document.querySelector('[aria-label="成りの選択"]')).not.toBeNull();
    if (choice === "Escape") {
      act(() =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(document.querySelector('[aria-label="成りの選択"]')).toBeNull();
      expect(sent).toHaveLength(0);
    } else {
      const button = document.querySelector<HTMLButtonElement>(`[aria-label="${choice}"]`)!;
      act(() => {
        button.click();
        button.click();
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ ...candidate, promote: choice !== "成らない" });
    }
    rerender(view, null);
  }
});
test("禁止候補だけの駒は選択・解除できるが送信せず、ロビー初期図の36駒を表示", () => {
  const sent: FourShogiAction[] = [],
    props = boardProps((action) => {
      sent.push(action);
      return true;
    });
  const forbidden = props.legalActions.filter(
    (a) => a.type === "movePiece" && a.from.x === 4 && a.from.y === 6,
  );
  const view = render(
    <FourShogiBoardLayout
      {...props}
      legalActions={[]}
      threePlayerAttackForbiddenActions={forbidden}
    />,
  );
  act(() => square(view, 4, 6).click());
  expect(square(view, 4, 6).getAttribute("aria-pressed")).toBe("true");
  act(() => square(view, 4, 5).click());
  expect(sent).toHaveLength(0);
  act(() => square(view, 4, 6).click());
  expect(square(view, 4, 6).getAttribute("aria-pressed")).toBe("false");
  rerender(view, <FourShogiLobbyBoardPreview />);
  expect(view.querySelectorAll('[data-testid="shogi-piece"]')).toHaveLength(36);
  for (const direction of ["up", "down", "left", "right"])
    expect(view.querySelectorAll(`[data-piece-direction="${direction}"]`)).toHaveLength(9);
});

test("偽pointerイベントで盤上と持ち駒のdrag状態・取消・revision変更を検証", () => {
  const props = boardProps(() => {
    throw new Error("cancelled drag must not send");
  });
  const view = render(<FourShogiBoardLayout {...props} />);
  const capture = new Set<number>();
  const set = spyOn(window.HTMLElement.prototype, "setPointerCapture").mockImplementation((id) => {
    capture.add(id);
  });
  const has = spyOn(window.HTMLElement.prototype, "hasPointerCapture").mockImplementation((id) =>
    capture.has(id),
  );
  const release = spyOn(window.HTMLElement.prototype, "releasePointerCapture").mockImplementation(
    (id) => {
      capture.delete(id);
    },
  );
  const event = (element: HTMLElement, type: string, x = 0) =>
    act(() =>
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 7,
          isPrimary: true,
          button: 0,
          clientX: x,
          bubbles: true,
        }),
      ),
    );
  try {
    for (const source of [
      square(view, 4, 6),
      view.querySelector<HTMLButtonElement>('button[aria-label^="南の持ち駒"]')!,
    ]) {
      event(source, "pointerdown");
      event(source, "pointermove", 10);
      expect(source.getAttribute("data-dragging")).toBe("true");
      expect(view.querySelector('[data-testid="shogi-drag-ghost"]')).not.toBeNull();
      event(source, "pointercancel");
      expect(source.hasAttribute("data-dragging")).toBe(false);
      expect(view.querySelector('[data-testid="shogi-drag-ghost"]')).toBeNull();
      expect(capture.size).toBe(0);
    }
    const source = square(view, 4, 6);
    event(source, "pointerdown");
    event(source, "pointermove", 10);
    rerender(view, <FourShogiBoardLayout {...props} revision="changed" />);
    expect(source.hasAttribute("data-dragging")).toBe(false);
    expect(capture.size).toBe(0);
  } finally {
    set.mockRestore();
    has.mockRestore();
    release.mockRestore();
  }
});

test("持ち駒の禁止候補だけでも選択・解除でき、成りだけ禁止なら合法な不成を直接送る", () => {
  const sent: FourShogiAction[] = [],
    props = boardProps((action) => {
      sent.push(action);
      return true;
    });
  const drop = props.legalActions.find((action) => action.type === "dropPiece");
  if (!drop || drop.type !== "dropPiece") throw new Error("drop fixture");
  const view = render(
    <FourShogiBoardLayout
      {...props}
      legalActions={[]}
      threePlayerAttackForbiddenActions={[drop]}
    />,
  );
  const hand = view.querySelector<HTMLButtonElement>(
    `button[aria-label^="南の持ち駒"][data-hand-kind="${drop.pieceKind}"]`,
  )!;
  expect(hand.disabled).toBe(false);
  act(() => hand.click());
  expect(hand.getAttribute("aria-pressed")).toBe("true");
  expect(
    square(view, drop.to.x, drop.to.y).getAttribute("data-three-player-attack-forbidden"),
  ).toBe("true");
  act(() => square(view, drop.to.x, drop.to.y).click());
  expect(sent).toHaveLength(0);
  act(() => hand.click());
  expect(hand.getAttribute("aria-pressed")).toBe("false");
  rerender(
    view,
    <FourShogiBoardLayout
      {...props}
      revision="drop"
      legalActions={[drop]}
      threePlayerAttackForbiddenActions={[]}
    />,
  );
  act(() => hand.click());
  act(() => square(view, drop.to.x, drop.to.y).click());
  expect(sent).toEqual([drop]);
  const promoted = props.legalActions.find(
    (action) =>
      action.type === "movePiece" &&
      action.promote &&
      props.legalActions.some(
        (other) =>
          other.type === "movePiece" &&
          !other.promote &&
          JSON.stringify(other.from) === JSON.stringify(action.from) &&
          JSON.stringify(other.to) === JSON.stringify(action.to),
      ),
  );
  if (!promoted || promoted.type !== "movePiece") throw new Error("promotion fixture");
  const plain = { ...promoted, promote: false };
  rerender(
    view,
    <FourShogiBoardLayout
      {...props}
      revision="promotion"
      legalActions={[plain]}
      threePlayerAttackForbiddenActions={[promoted]}
    />,
  );
  act(() => square(view, plain.from.x, plain.from.y).click());
  act(() => square(view, plain.to.x, plain.to.y).click());
  expect(sent).toEqual([drop, plain]);
  expect(document.querySelector('[aria-label="成りの選択"]')).toBeNull();
});
