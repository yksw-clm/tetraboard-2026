import type { FourShogiAction, Piece, Position, Side } from "@tetraboard/four-shogi";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import boardImage from "../../assets/shogi/board.png";
import { FourShogiHand } from "./FourShogiHand";
import { ShogiPiece } from "./ShogiPiece";
import { prepareShogiPieceImages } from "./shogiPieceImages";
import { ShogiPromotionChoice } from "./ShogiPromotionChoice";
import { useShogiPromotion, type ShogiPromotionContext } from "./useShogiPromotion";
import {
  shogiActionChoices,
  shogiBoardPosition,
  shogiBoardPositionAtPoint,
  shogiDragThresholdReached,
  shogiPieceDirection,
  shogiPieceNames,
  shogiPieceLiftClasses,
  shogiSamePosition,
  shogiSameSelection,
  shogiSideNames,
  shogiSidePlacement,
  shogiSides,
  type ShogiBoardView,
  type ShogiPieceDirection,
  type ShogiSelection,
} from "./shogiBoardPresentation";

type Revision = string | number;
type Selected = { selection: ShogiSelection; revision: Revision };
type DragSource = {
  selection: ShogiSelection;
  kind: Piece["kind"];
  promoted: boolean;
  direction: ShogiPieceDirection;
};
type PointerTrace = DragSource & {
  pointerId: number;
  element: HTMLButtonElement;
  start: Position;
  moved: boolean;
  width: number;
  revision: Revision;
};
type Drag = DragSource & { point: Position; width: number };

// board.png の罫線（アンチエイリアス部分を含む）の原寸での左右／上下端。
// 等分した操作マスとの差を補正し、装飾を罫線の内縁まで広げる。
const boardLines = {
  x: [
    [6, 8],
    [55, 57],
    [105, 107],
    [154, 156],
    [203, 206],
    [253, 255],
    [302, 305],
    [352, 354],
    [401, 404],
    [451, 453],
  ],
  y: [
    [5, 7],
    [59, 62],
    [114, 116],
    [168, 170],
    [222, 224],
    [276, 278],
    [330, 332],
    [384, 387],
    [438, 441],
    [493, 495],
  ],
} as const;

function squareHighlightStyle(index: number): CSSProperties {
  const x = index % 9;
  const y = Math.floor(index / 9);
  const width = 446 / 9;
  const height = 488 / 9;
  return {
    left: `${((boardLines.x[x][1] - (6 + x * width)) / width) * 100}%`,
    right: `${((6 + (x + 1) * width - boardLines.x[x + 1][0]) / width) * 100}%`,
    top: `${((boardLines.y[y][1] - (6 + y * height)) / height) * 100}%`,
    bottom: `${((6 + (y + 1) * height - boardLines.y[y + 1][0]) / height) * 100}%`,
  };
}

const groupClasses = {
  top: "[grid-area:top] w-fit justify-self-center flex-row-reverse items-center [@media(max-width:767px)]:w-full [@media(max-width:767px)]:flex-col",
  bottom:
    "[grid-area:bottom] w-fit justify-self-center flex-row items-center [@media(max-width:767px)]:w-full [@media(max-width:767px)]:flex-col-reverse",
  left: "[grid-area:left] flex-col items-end justify-start h-full [@media(max-width:767px)]:h-auto [@media(max-width:767px)]:items-center",
  right:
    "[grid-area:right] flex-col-reverse items-start justify-start h-full [@media(max-width:767px)]:h-auto [@media(max-width:767px)]:items-center",
} as const;

export type FourShogiBoardLayoutProps = {
  game: ShogiBoardView;
  viewerSide: Side;
  revision: Revision;
  canPlay: boolean;
  promotionContext?: ShogiPromotionContext;
  legalActions: readonly FourShogiAction[];
  threePlayerAttackForbiddenActions?: readonly FourShogiAction[];
  checkState?: Readonly<Record<Side, boolean>>;
  onAction: (action: FourShogiAction) => void;
  playerCards: Readonly<Record<Side, ReactNode>>;
};

export function FourShogiBoardLayout({
  game,
  viewerSide,
  revision,
  canPlay,
  promotionContext,
  legalActions,
  threePlayerAttackForbiddenActions = [],
  checkState,
  onAction,
  playerCards,
}: FourShogiBoardLayoutProps) {
  const layout = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLImageElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const images = [
      ...(layout.current?.querySelectorAll<HTMLImageElement>("img[data-piece-direction]") ?? []),
    ];
    if (board.current) images.push(board.current);
    // 初期表示の通信を優先し、成り駒・裏王の準備は画面を待たせません。
    void Promise.allSettled(images.map((image) => image.decode())).then(() => {
      if (active) void prepareShogiPieceImages();
    });
    return () => {
      active = false;
    };
  }, []);
  const trace = useRef<PointerTrace | null>(null);
  const suppressClick = useRef(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const eliminated = game.eliminations.map((entry) => entry.side);
  const enabled = canPlay && game.status === "playing" && game.turn === viewerSide;
  const selectableActions = [...legalActions, ...threePlayerAttackForbiddenActions];
  const promotion = useShogiPromotion(promotionContext, legalActions, enabled);
  const promotionChoices = promotion.choices;
  const sent = useRef(false);
  const [interactionScope, setInteractionScope] = useState({ revision, viewerSide, enabled });

  // 局面や操作権限の変更と同じ描画で解除し、以前の選択が再表示されることを防ぎます。
  if (
    interactionScope.revision !== revision ||
    interactionScope.viewerSide !== viewerSide ||
    interactionScope.enabled !== enabled
  ) {
    setInteractionScope({ revision, viewerSide, enabled });
    setSelected(null);
    setDrag(null);
  }
  const selection =
    enabled && selected?.revision === revision
      ? selected.selection
      : promotionChoices
        ? { type: "movePiece" as const, from: promotionChoices[0].from }
        : null;

  function resetPointer(): void {
    const active = trace.current;
    trace.current = null;
    if (active?.element.hasPointerCapture(active.pointerId)) {
      active.element.releasePointerCapture(active.pointerId);
    }
    setDrag(null);
  }

  function cancelSelection(restoreFocus = false): void {
    if (restoreFocus && promotionChoices) {
      const from = promotionChoices[0].from;
      grid.current
        ?.querySelector<HTMLButtonElement>(`[data-square="${"ABCDEFGHI"[from.x]}${from.y + 1}"]`)
        ?.focus({ preventScroll: true });
    }
    promotion.clear();
    resetPointer();
    setSelected(null);
  }

  useEffect(() => {
    sent.current = false;
    const active = trace.current;
    trace.current = null;
    if (active?.element.hasPointerCapture(active.pointerId)) {
      active.element.releasePointerCapture(active.pointerId);
    }
    // 更新前のpointerupに続くclickを、新しい局面の選択として受け付けません。
    suppressClick.current = active !== null;
  }, [revision, viewerSide, enabled]);

  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    const active = trace.current !== null;
    if (promotionChoices) event.preventDefault();
    cancelSelection(true);
    suppressClick.current = active;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      onEscape(event);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const active = trace.current;
      trace.current = null;
      if (active?.element.hasPointerCapture(active.pointerId)) {
        active.element.releasePointerCapture(active.pointerId);
      }
    };
  }, []);

  function consumeClick(): boolean {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  }

  function select(next: ShogiSelection): void {
    if (!enabled || consumeClick()) return;
    setSelected(
      selection && shogiSameSelection(selection, next) ? null : { selection: next, revision },
    );
  }

  function send(action: FourShogiAction): void {
    if (!enabled || sent.current) return;
    sent.current = true;
    cancelSelection();
    onAction(action);
  }

  function chooseDestination(source: ShogiSelection, to: Position): void {
    if (!enabled) return;
    const choices = shogiActionChoices(legalActions, source, to);
    if (choices.length === 1) send(choices[0]);
    else if (choices.length > 1) promotion.open(choices);
  }

  function onSquareClick(position: Position, canSelect: boolean): void {
    if (consumeClick() || !enabled) return;
    if (selection && shogiActionChoices(legalActions, selection, position).length > 0) {
      chooseDestination(selection, position);
    } else if (canSelect) {
      select({ type: "movePiece", from: position });
    }
  }

  function startPointer(event: PointerEvent<HTMLButtonElement>, source: DragSource): void {
    if (!enabled || event.button !== 0 || !event.isPrimary || promotionChoices) return;
    suppressClick.current = false;
    const image = event.currentTarget.querySelector("img");
    trace.current = {
      ...source,
      pointerId: event.pointerId,
      element: event.currentTarget,
      start: { x: event.clientX, y: event.clientY },
      moved: false,
      width: image?.clientWidth ?? 30,
      revision,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePointer(event: PointerEvent<HTMLButtonElement>): void {
    const active = trace.current;
    if (!active || active.pointerId !== event.pointerId || active.revision !== revision || !enabled)
      return;
    const point = { x: event.clientX, y: event.clientY };
    if (!active.moved && !shogiDragThresholdReached(active.start, point)) return;
    active.moved = true;
    event.preventDefault();
    setSelected({ selection: active.selection, revision });
    setDrag({ ...active, point });
  }

  function endPointer(event: PointerEvent<HTMLButtonElement>): void {
    const active = trace.current;
    if (!active || active.pointerId !== event.pointerId) return;
    resetPointer();
    if (!active.moved) return;
    suppressClick.current = true;
    if (!enabled || active.revision !== revision || !grid.current) return;
    const to = shogiBoardPositionAtPoint(
      { x: event.clientX, y: event.clientY },
      grid.current.getBoundingClientRect(),
      viewerSide,
    );
    if (to) chooseDestination(active.selection, to);
  }

  function cancelPointer(): void {
    suppressClick.current = true;
    cancelSelection();
  }

  function lostPointer(): void {
    if (trace.current) cancelPointer();
  }

  function hand(side: Side, direction: ShogiPieceDirection, vertical = false) {
    const availableKinds =
      enabled && side === viewerSide
        ? selectableActions.flatMap((action) =>
            action.type === "dropPiece" ? [action.pieceKind] : [],
          )
        : [];
    return (
      <FourShogiHand
        hand={game.hands[side]}
        label={`${shogiSideNames[side]}の持ち駒`}
        direction={direction}
        vertical={vertical}
        selectedKind={
          side === viewerSide && selection?.type === "dropPiece" ? selection.pieceKind : null
        }
        availableKinds={availableKinds}
        draggingKind={
          side === viewerSide && drag?.selection.type === "dropPiece"
            ? drag.selection.pieceKind
            : null
        }
        onSelect={(kind, event) => {
          if (event.detail === 0) suppressClick.current = false;
          select({ type: "dropPiece", pieceKind: kind });
        }}
        onPointerDown={(event, kind) =>
          startPointer(event, {
            selection: { type: "dropPiece", pieceKind: kind },
            kind,
            promoted: false,
            direction,
          })
        }
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={lostPointer}
      />
    );
  }

  const lastAction = game.lastMove?.action;
  // スマホではカード2段・持ち駒2段・4つの間隔を除いた高さに収めます。
  // 持ち駒の高さも盤の幅に比例するため、盤と駒2段の比率を合わせて計算します。
  return (
    <div
      ref={layout}
      data-testid="shogi-board-layout"
      className="[--player-height:60px] [@media(max-width:767px)]:[--player-height:48px] [--seat-width:var(--shogi-side-width)] [@media(max-width:767px)]:[--seat-width:100%] [--shogi-side-width:clamp(140px,21cqw,220px)] [--shogi-board-width:max(180px,min(458px,calc(100cqw_-_2_*_var(--shogi-side-width)_-_16px),calc((100cqh_-_2_*_var(--player-height)_-_24px)_*_458_/_500)))] [--shogi-piece-width:calc(var(--shogi-board-width)_*_446_/_458_/_9_*_0.82)] grid w-full min-h-full grid-cols-[var(--shogi-side-width)_var(--shogi-board-width)_var(--shogi-side-width)] grid-rows-[var(--player-height)_calc(var(--shogi-board-width)_*_500_/_458)_var(--player-height)] [grid-template-areas:'top_top_top'_'left_board_right'_'bottom_bottom_bottom'] gap-2 content-center justify-center py-2 [@media(max-width:767px)]:[--shogi-board-width:max(0px,min(100cqw,calc((100cqh_-_2_*_var(--player-height)_-_2_*_6px_-_4_*_2px)_/_(500_/_458_+_2_*_446_/_458_/_9_*_0.82_*_148_/_140))))] [@media(max-width:767px)]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] [@media(max-width:767px)]:grid-rows-[auto_auto_auto] [@media(max-width:767px)]:[grid-template-areas:'left_top'_'board_board'_'bottom_right'] [@media(max-width:767px)]:gap-[2px] [@media(max-width:767px)]:content-start [@media(max-width:767px)]:py-0"
    >
      {shogiSides.map((side) => {
        const placement = shogiSidePlacement(side, viewerSide);
        const vertical = placement === "left" || placement === "right";
        const above = placement === "left" || placement === "top";
        return (
          <div
            key={side}
            data-side={side}
            data-board-position={placement}
            className={`flex min-w-0 gap-[6px] [@media(max-width:767px)]:gap-[2px] ${groupClasses[placement]}`}
          >
            <div className="w-[var(--seat-width)] shrink-0 min-w-0">{playerCards[side]}</div>
            <div className="hidden shrink-0 min-w-0 [@media(min-width:768px)]:flex justify-center">
              {hand(side, shogiPieceDirection(side, viewerSide), vertical)}
            </div>
            <div className="flex w-full justify-center [@media(min-width:768px)]:hidden">
              {hand(side, above ? "down" : "up")}
            </div>
          </div>
        );
      })}
      <div
        data-testid="shogi-board"
        className="[grid-area:board] relative w-[var(--shogi-board-width)] aspect-[458/500] place-self-center shadow-[0_8px_24px_#71531c25]"
        role="group"
        aria-label="四人将棋の盤面"
      >
        <img
          ref={board}
          src={boardImage}
          alt=""
          draggable={false}
          className="absolute inset-0 block size-full select-none pointer-events-none"
        />
        <div
          ref={grid}
          className="absolute inset-x-[1.3100437%] inset-y-[1.2%] grid grid-cols-9 grid-rows-9"
        >
          {Array.from({ length: 81 }, (_, index) => {
            const position = shogiBoardPosition(
              { x: index % 9, y: Math.floor(index / 9) },
              viewerSide,
            );
            const piece = game.board[position.y][position.x];
            const dead = piece !== null && eliminated.includes(piece.side);
            const canSelect =
              enabled &&
              piece?.side === viewerSide &&
              selectableActions.some(
                (action) => action.type === "movePiece" && shogiSamePosition(action.from, position),
              );
            const choices = selection ? shogiActionChoices(legalActions, selection, position) : [];
            const destination = enabled && choices.length > 0;
            const forbiddenDestination =
              enabled &&
              !destination &&
              selection !== null &&
              shogiActionChoices(threePlayerAttackForbiddenActions, selection, position).length > 0;
            const selectedSquare =
              selection?.type === "movePiece" && shogiSamePosition(selection.from, position);
            const lastFrom =
              lastAction?.type === "movePiece" && shogiSamePosition(lastAction.from, position);
            const lastTo = lastAction && shogiSamePosition(lastAction.to, position);
            const dragging =
              drag?.selection.type === "movePiece" &&
              shogiSamePosition(drag.selection.from, position);
            const checked = piece?.kind === "king" && !dead && checkState?.[piece.side];
            const pieceLabel = piece
              ? `${shogiSideNames[piece.side]}の${piece.kind === "king" && dead ? "裏王" : piece.promoted ? (piece.kind === "rook" ? "龍" : piece.kind === "silver" ? "成銀" : "と金") : shogiPieceNames[piece.kind]}`
              : "空き";
            return (
              <button
                key={index}
                type="button"
                disabled={!canSelect && !destination}
                data-square={`${"ABCDEFGHI"[position.x]}${position.y + 1}`}
                data-selected={selectedSquare || undefined}
                data-legal-destination={destination || undefined}
                data-three-player-attack-forbidden={forbiddenDestination || undefined}
                data-last-move={lastTo ? "to" : lastFrom ? "from" : undefined}
                data-check={checked || undefined}
                data-dragging={dragging || undefined}
                aria-label={`${"ABCDEFGHI"[position.x]}${position.y + 1}：${pieceLabel}${dead && piece?.kind !== "king" ? "、脱落した駒" : ""}${canSelect ? "、選択できます" : ""}${destination ? "、移動できます" : ""}${forbiddenDestination ? "、三人攻撃のため着手できません" : ""}${checked ? "、王手" : ""}${lastFrom ? "、直前の移動元" : ""}${lastTo ? "、直前の移動先" : ""}`}
                aria-pressed={!!selectedSquare}
                className={`group/shogi-piece relative grid place-items-center min-w-0 min-h-0 w-full h-full p-0 rounded-none border-0 bg-transparent focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-[-3px] ${canSelect ? "touch-none" : "touch-auto"}${canSelect || destination ? " cursor-pointer" : " cursor-default"}`}
                onClick={(event) => {
                  if (event.detail === 0) suppressClick.current = false;
                  onSquareClick(position, !!canSelect);
                }}
                onPointerDown={(event) => {
                  if (piece && canSelect)
                    startPointer(event, {
                      selection: { type: "movePiece", from: position },
                      kind: piece.kind,
                      promoted: piece.promoted,
                      direction: shogiPieceDirection(piece.side, viewerSide),
                    });
                }}
                onPointerMove={movePointer}
                onPointerUp={endPointer}
                onPointerCancel={cancelPointer}
                onLostPointerCapture={lostPointer}
              >
                <span
                  aria-hidden="true"
                  data-testid="shogi-square-highlight"
                  style={squareHighlightStyle(index)}
                  className={`absolute pointer-events-none ${checked ? "bg-[#e93f3540] shadow-[inset_0_0_0_2px_#b84625]" : selectedSquare ? "bg-[#ffeb8980] shadow-[inset_0_0_0_2px_#9c6f14]" : lastFrom ? "bg-[#54361870]" : canSelect || destination ? "group-hover/shogi-piece:bg-[#fff0b735]" : ""}${lastTo ? " ring-2 ring-inset ring-[#9c6f14]" : ""}`}
                />
                {piece && (
                  <span
                    className={`relative ${dead && piece.kind !== "king" ? "opacity-55" : ""} ${dragging ? "invisible" : canSelect || selectedSquare ? shogiPieceLiftClasses(!!selectedSquare) : ""}`}
                  >
                    <ShogiPiece
                      kind={piece.kind}
                      promoted={piece.promoted}
                      deadKing={piece.kind === "king" && dead}
                      direction={shogiPieceDirection(piece.side, viewerSide)}
                    />
                  </span>
                )}
                {(destination || forbiddenDestination) && (
                  <span
                    aria-hidden="true"
                    className={`absolute size-[18%] rounded-full ring-1 pointer-events-none ${forbiddenDestination ? "bg-[#e93f35b0] ring-[#fff0edc7]" : "bg-[#267541b0] ring-[#f6ffd8c7]"}`}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
      {drag && (
        <div
          aria-hidden="true"
          data-testid="shogi-drag-ghost"
          className="fixed z-[100] pointer-events-none opacity-85 drop-shadow-[0_4px_4px_#54361870]"
          style={
            {
              left: drag.point.x - drag.width / 2,
              top: drag.point.y - (drag.width * 148) / 140 / 2,
              "--shogi-piece-width": `${drag.width}px`,
            } as CSSProperties
          }
        >
          <ShogiPiece kind={drag.kind} promoted={drag.promoted} direction={drag.direction} />
        </div>
      )}
      {promotionChoices && (
        <ShogiPromotionChoice
          choices={promotionChoices}
          kind={game.board[promotionChoices[0].from.y][promotionChoices[0].from.x]!.kind}
          viewerSide={viewerSide}
          grid={grid}
          onChoose={send}
        />
      )}
    </div>
  );
}
