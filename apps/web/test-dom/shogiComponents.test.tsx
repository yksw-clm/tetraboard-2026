import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { applyAction, type FourShogiAction } from "@tetraboard/four-shogi";
import { ShogiPiece } from "../src/features/room/ShogiPiece";
import boardImage from "../src/assets/shogi/board.png";
import { createShogiImageStore } from "../src/features/room/shogiImageStore";
import {
  prepareShogiAssets,
  shogiImageStore,
  shogiPieceImage,
} from "../src/features/room/shogiPieceImages";
import {
  FourShogiBoardLayout,
  type FourShogiBoardLayoutProps,
} from "../src/features/room/FourShogiBoardLayout";
import { LobbyBoardPreview } from "../src/features/lobby/LobbyBoardPreview";
import {
  playingShogiRoom,
  publicShogiState,
  tacticalShogiState,
} from "../test/fixtures/fourShogiFixtures";
import { act, flush, render, rerender } from "./harness";

type PendingImage = {
  image: HTMLImageElement;
  finish: (complete?: boolean, width?: number) => void;
  reject: () => void;
};
let pendingImages: PendingImage[];
let imageMocks: { mockRestore: () => void }[];
beforeEach(() => {
  pendingImages = [];
  const store = createShogiImageStore();
  imageMocks = [
    spyOn(shogiImageStore, "getStatus").mockImplementation(store.getStatus),
    spyOn(shogiImageStore, "subscribe").mockImplementation(store.subscribe),
    spyOn(shogiImageStore, "prepare").mockImplementation(store.prepare),
    spyOn(window.HTMLImageElement.prototype, "decode").mockImplementation(function (
      this: HTMLImageElement,
    ) {
      return new Promise<void>((resolve, reject) =>
        pendingImages.push({
          image: this,
          finish: (complete = true, width = 140) => {
            Object.defineProperty(this, "complete", { configurable: true, value: complete });
            Object.defineProperty(this, "naturalWidth", { configurable: true, value: width });
            resolve();
          },
          reject: () => reject(new Error("decode failure")),
        }),
      );
    }),
  ];
});
afterEach(() => {
  for (const mock of imageMocks) mock.mockRestore();
});
const pendingFor = (src: string) => pendingImages.find((p) => p.image.getAttribute("src") === src)!;
const pieceVisible = (view: HTMLElement) => {
  const images = [...view.querySelectorAll<HTMLImageElement>('[data-testid="shogi-piece"]')];
  return images.length > 0 && images.every((image) => !image.className.includes("invisible"));
};

test("盤と全18駒を初回に準備し、処理中・成功・失敗の同じURLを再取得しない", async () => {
  const first = prepareShogiAssets();
  const pawn = shogiPieceImage("pawn", false, false, "up").src;
  const preparation = shogiImageStore.prepare(pawn);
  expect(shogiImageStore.prepare(pawn)).toBe(preparation);
  expect(shogiImageStore.getStatus(pawn)).toBe("loading");
  await flush();
  expect(pendingImages).toHaveLength(19);
  expect(new Set(pendingImages.map((p) => p.image.src)).size).toBe(19);
  expect(pendingFor(boardImage)).toBeDefined();
  for (const direction of ["up", "down"] as const) {
    for (const kind of ["king", "rook", "gold", "silver", "pawn"] as const)
      expect(pendingFor(shogiPieceImage(kind, false, false, direction).src)).toBeDefined();
    for (const kind of ["rook", "silver", "pawn"] as const)
      expect(pendingFor(shogiPieceImage(kind, true, false, direction).src)).toBeDefined();
    expect(pendingFor(shogiPieceImage("king", false, true, direction).src)).toBeDefined();
  }
  const again = prepareShogiAssets();
  await flush();
  expect(pendingImages).toHaveLength(19);
  const failed = shogiPieceImage("king", false, true, "down").src;
  for (const pending of pendingImages)
    if (pending === pendingFor(failed)) pending.reject();
    else pending.finish();
  await Promise.all([first, again]);
  expect(shogiImageStore.getStatus(pawn)).toBe("ready");
  expect(shogiImageStore.getStatus(failed)).toBe("error");
  await prepareShogiAssets();
  expect(pendingImages).toHaveLength(19);
});

test("読み込み済みの歩は移動先への再マウント直後から画像を表示する", async () => {
  const board = (position: number) => (
    <div>
      {[0, 1].map((index) => (
        <div key={index}>{position === index && <ShogiPiece kind="pawn" direction="up" />}</div>
      ))}
    </div>
  );
  const view = render(board(0));
  expect(view.textContent).toBe("歩");
  await flush();
  pendingImages[0]!.finish();
  await flush();
  const originalImage = view.querySelector("img")!;
  expect(view.textContent).toBe("");
  rerender(view, board(1));
  expect(view.querySelector("img")).not.toBe(originalImage);
  expect(view.querySelector("img")!.src).toBe(originalImage.src);
  // 非同期処理を進める前の表示を確認します。
  expect(view.textContent).toBe("");
  expect(pieceVisible(view)).toBe(true);
  await flush();
  expect(pendingImages).toHaveLength(1);
});

test("先読みした成駒・裏王は初回描画と向き変更で文字へ戻らない", async () => {
  const preparation = prepareShogiAssets();
  await flush();
  for (const pending of pendingImages) pending.finish();
  await preparation;
  const view = render(<ShogiPiece kind="rook" promoted direction="up" />);
  expect(view.textContent).toBe("");
  expect(pieceVisible(view)).toBe(true);
  for (const direction of ["right", "down", "left", "up"] as const) {
    for (const kind of ["rook", "silver", "pawn"] as const) {
      rerender(view, <ShogiPiece kind={kind} promoted direction={direction} />);
      expect(view.textContent).toBe("");
      expect(pieceVisible(view)).toBe(true);
    }
    rerender(view, <ShogiPiece kind="king" deadKing direction={direction} />);
    expect(view.textContent).toBe("");
    expect(pieceVisible(view)).toBe(true);
  }
  await flush();
  expect(pendingImages).toHaveLength(19);
});

test("駒名・方向・srcとdecode待ちの代替表示、古いURLの完了を検証", async () => {
  const view = render(<ShogiPiece kind="silver" promoted direction="right" />);
  expect(view.textContent).toBe("成銀");
  expect(view.querySelector("img")!.getAttribute("data-piece-direction")).toBe("right");
  expect(view.querySelector("img")!.getAttribute("src")).toBe(
    shogiPieceImage("silver", true, false, "right").src,
  );
  await flush();
  const previous = pendingImages[0]!;
  rerender(view, <ShogiPiece kind="king" deadKing direction="down" />);
  await flush();
  previous.finish();
  await flush();
  expect(view.textContent).toBe("裏王");
  pendingImages[1]!.reject();
  await flush();
  expect(view.textContent).toBe("裏王");
  rerender(view, <ShogiPiece kind="rook" promoted direction="left" />);
  expect(view.textContent).toBe("龍");
  await flush();
  pendingImages[2]!.finish();
  await flush();
  expect(view.textContent).toBe("");
  expect(pieceVisible(view)).toBe(true);
});

test("decode成功でも未完了・寸法0の画像は失敗として文字表示を維持する", async () => {
  const view = render(
    <>
      <ShogiPiece kind="gold" direction="up" />
      <ShogiPiece kind="gold" direction="down" />
    </>,
  );
  await flush();
  pendingImages[0]!.finish(false);
  pendingImages[1]!.finish(true, 0);
  await flush();
  expect(view.textContent).toBe("金金");
  expect(pieceVisible(view)).toBe(false);
  expect(pendingImages).toHaveLength(2);
});

test("表示用画像の失敗はその要素だけ文字に戻し、URL変更後や別要素へ持ち越さない", async () => {
  const preparation = prepareShogiAssets();
  await flush();
  for (const pending of pendingImages) pending.finish();
  await preparation;
  const view = render(<ShogiPiece kind="rook" direction="up" />);
  const sibling = render(<ShogiPiece kind="rook" direction="up" />);
  act(() => view.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(view.textContent).toBe("飛");
  expect(sibling.textContent).toBe("");
  rerender(view, <ShogiPiece kind="rook" promoted direction="up" />);
  expect(view.textContent).toBe("");
  rerender(view, <ShogiPiece kind="rook" direction="up" />);
  expect(view.textContent).toBe("");
});

test("購読解除後は通知せず、表示を閉じても準備結果は次の表示へ引き継ぐ", async () => {
  const src = shogiPieceImage("silver", false, false, "down").src;
  let notifications = 0;
  const unsubscribe = shogiImageStore.subscribe(src, () => notifications++);
  const view = render(<ShogiPiece kind="silver" direction="down" />);
  await flush();
  expect(notifications).toBe(1);
  unsubscribe();
  rerender(view, <></>);
  pendingImages[0]!.finish();
  await flush();
  expect(notifications).toBe(1);
  expect(view.textContent).toBe("");
  rerender(view, <ShogiPiece kind="silver" direction="down" />);
  expect(view.textContent).toBe("");
  expect(pieceVisible(view)).toBe(true);
});

test("ロビーの専用画像はルームの画像準備を始めず、入室時に全19URLを準備する", async () => {
  const lobby = render(<LobbyBoardPreview game="four-shogi" />);
  await flush();
  expect(lobby.querySelectorAll("img")).toHaveLength(1);
  expect(pendingImages).toHaveLength(0);
  render(<FourShogiBoardLayout {...boardProps(() => true)} />);
  await flush();
  expect(pendingImages).toHaveLength(19);
  expect(pendingFor(boardImage)).toBeDefined();
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

test("PC・スマホの持ち駒は全閲覧方向で盤上駒と向きをそろえ、既存の並び順と枚数を保つ", () => {
  const props = boardProps(() => true);
  const view = render(<FourShogiBoardLayout {...props} canPlay={false} />);
  const sides = ["south", "west", "north", "east"] as const;
  const names = ["南", "西", "北", "東"];
  const cases = [
    ["south", ["up", "right", "down", "left"]],
    ["west", ["left", "up", "right", "down"]],
    ["north", ["down", "left", "up", "right"]],
    ["east", ["right", "down", "left", "up"]],
  ] as const;
  const forward = ["pawn", "silver", "gold", "rook"];
  const backward = ["rook", "gold", "silver", "pawn"];
  for (const [viewerSide, directions] of cases) {
    rerender(view, <FourShogiBoardLayout {...props} viewerSide={viewerSide} canPlay={false} />);
    for (const [index, side] of sides.entries()) {
      const direction = directions[index];
      const boardKing = view.querySelector(
        `[data-testid="shogi-board"] button[aria-label*="${names[index]}の王"] img`,
      )!;
      expect(boardKing.getAttribute("data-piece-direction")).toBe(direction);
      const hands = view.querySelectorAll(`[data-side="${side}"] [data-testid="shogi-hand"]`);
      expect(hands).toHaveLength(2);
      for (const [handIndex, hand] of [...hands].entries()) {
        expect(hand.getAttribute("data-hand-direction")).toBe(direction);
        const buttons = [...hand.querySelectorAll<HTMLButtonElement>("button")];
        const reversed =
          handIndex === 0
            ? direction === "down" || direction === "left"
            : direction === "down" || direction === "right";
        expect(buttons.map((button) => button.getAttribute("data-hand-kind"))).toEqual(
          reversed ? backward : forward,
        );
        for (const button of buttons) {
          expect(button.querySelector("img")!.getAttribute("data-piece-direction")).toBe(direction);
          expect(button.disabled).toBe(true);
        }
        const pawn = hand.querySelector('[data-hand-kind="pawn"]')!;
        expect(pawn.getAttribute("aria-label")).toBe(`${names[index]}の持ち駒、歩3枚`);
        expect(pawn.lastElementChild!.textContent).toBe("3");
      }
    }
  }
});

test("捕獲・打ち駒・成り後の盤面と持ち駒、観戦回転・再表示でも画像準備を再利用する", async () => {
  const initial = tacticalShogiState();
  const state = {
    ...initial,
    hands: { ...initial.hands, south: { ...initial.hands.south, silver: 0 } },
  };
  const room = playingShogiRoom(state);
  const props = { ...boardProps(() => true), game: room.game, legalActions: room.legalActions };
  const view = render(<FourShogiBoardLayout {...props} />);
  await flush();
  for (const pending of pendingImages) pending.finish();
  await flush();
  expect(pieceVisible(view)).toBe(true);
  const actions = [
    { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
    props.legalActions.find((action) => action.type === "dropPiece"),
    props.legalActions.find((action) => action.type === "movePiece" && action.promote),
  ] as const;
  for (const [index, action] of actions.entries()) {
    if (!action) throw new Error("missing fixture action");
    const result = applyAction(state, "south", action);
    if (!result.ok) throw new Error("invalid fixture action");
    const game = publicShogiState(result.state);
    rerender(
      view,
      <FourShogiBoardLayout {...props} game={game} revision={`move:${index}`} canPlay={false} />,
    );
    const moved = square(view, action.to.x, action.to.y);
    expect(moved.querySelector('[data-testid="shogi-piece"]')).not.toBeNull();
    expect(pieceVisible(moved)).toBe(true);
    if (index === 0) {
      const captured = view.querySelector<HTMLElement>(
        'button[aria-label^="南の持ち駒"][data-hand-kind="silver"]',
      )!;
      expect(captured).not.toBeNull();
      expect(pieceVisible(captured)).toBe(true);
    }
    expect(pieceVisible(view)).toBe(true);
    for (const viewerSide of ["west", "north", "east", "south"] as const) {
      rerender(
        view,
        <FourShogiBoardLayout
          {...props}
          game={game}
          viewerSide={viewerSide}
          revision={`replay:${index}`}
          canPlay={false}
        />,
      );
      expect(pieceVisible(view)).toBe(true);
    }
  }
  rerender(view, null);
  rerender(view, <FourShogiBoardLayout {...props} revision="next-round" />);
  expect(pieceVisible(view)).toBe(true);
  await flush();
  expect(pendingImages).toHaveLength(19);
});

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
test("成りメニューは先読み済み画像を表示し、選択まで送信せず一度だけ確定", async () => {
  const preparation = prepareShogiAssets();
  await flush();
  for (const pending of pendingImages) pending.finish();
  await preparation;
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
    expect(pieceVisible(document.querySelector<HTMLElement>('[aria-label="成りの選択"]')!)).toBe(
      true,
    );
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
test("禁止候補だけの駒は選択・解除できるが送信しない", () => {
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
});

test("盤上と持ち駒のdragは先読み済み画像を表示し、取消・revision変更で解除する", async () => {
  const preparation = prepareShogiAssets();
  await flush();
  for (const pending of pendingImages) pending.finish();
  await preparation;
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
      expect(
        pieceVisible(view.querySelector<HTMLElement>('[data-testid="shogi-drag-ghost"]')!),
      ).toBe(true);
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

test("脱落者の持ち駒を向き変更後も保持し、選択・pointer操作・着手を禁止する", () => {
  const sent: FourShogiAction[] = [];
  const props = boardProps((action) => {
    sent.push(action);
    return true;
  });
  const game = {
    ...props.game,
    eliminations: [{ side: "south" as const }],
    hands: { ...props.game.hands, south: { rook: 0, gold: 0, silver: 0, pawn: 0 } },
  };
  const retained = { south: { rook: 1, gold: 2, silver: 3, pawn: 12 } };
  const view = render(<FourShogiBoardLayout {...props} game={game} eliminatedHands={retained} />);
  for (const [viewerSide, direction] of [
    ["south", "up"],
    ["west", "left"],
    ["north", "down"],
    ["east", "right"],
  ] as const) {
    rerender(
      view,
      <FourShogiBoardLayout
        {...props}
        game={game}
        eliminatedHands={retained}
        viewerSide={viewerSide}
      />,
    );
    const buttons = [
      ...view.querySelectorAll<HTMLButtonElement>('button[aria-label^="南の持ち駒"]'),
    ];
    expect(buttons).toHaveLength(8);
    for (const button of buttons) {
      expect(button.querySelector("img")!.getAttribute("data-piece-direction")).toBe(direction);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.getAttribute("aria-label")).not.toContain("選択できます");
      act(() => {
        button.click();
        button.dispatchEvent(
          new PointerEvent("pointerdown", { button: 0, isPrimary: true, pointerId: 1 }),
        );
      });
    }
    expect(view.querySelector('[data-testid="shogi-drag-ghost"]')).toBeNull();
    expect(buttons.some((button) => button.getAttribute("aria-label")?.includes("歩12枚"))).toBe(
      true,
    );
  }
  const other = { ...props.game, eliminations: [{ side: "west" as const }] };
  rerender(
    view,
    <FourShogiBoardLayout {...props} game={other} eliminatedHands={{ west: retained.south }} />,
  );
  for (const button of view.querySelectorAll<HTMLButtonElement>(
    'button[aria-label^="西の持ち駒"]',
  )) {
    expect(button.disabled).toBe(true);
    act(() =>
      button.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, isPrimary: true, pointerId: 1 }),
      ),
    );
  }
  expect(view.querySelector('[data-testid="shogi-drag-ghost"]')).toBeNull();
  expect(sent).toHaveLength(0);
  rerender(view, <FourShogiBoardLayout {...props} game={game} />);
  expect(view.querySelectorAll('button[aria-label^="南の持ち駒"]')).toHaveLength(0);
});
