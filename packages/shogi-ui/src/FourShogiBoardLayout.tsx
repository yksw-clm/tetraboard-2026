import type { EliminatedHands, FourShogiAction as LegacyAction } from "@tetraboard/four-shogi";
import type { FourShogiAction, Piece, Position, Side } from "./shogiUiTypes";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import boardImage from "../assets/board-wood.png";
import { RoomBoardGroup } from "./RoomBoardGroup";
import { FourShogiHand } from "./FourShogiHand";
import { ShogiPiece } from "./ShogiPiece";
import { prepareShogiAssets } from "./shogiPieceImages";
import { ShogiPromotionChoice } from "./ShogiPromotionChoice";
import { shogiNotationFile, shogiNotationRank, shogiNotationSquare } from "./shogiNotation";
import { useLocalPromotion, type PromotionController } from "./useLocalPromotion";
import {
  shogiActionChoices,
  shogiBoardPosition,
  shogiDragThresholdReached,
  shogiPieceDirection,
  shogiPieceNames,
  shogiPieceLiftClasses,
  shogiSamePosition,
  shogiSameSelection,
  shogiSideNames,
  shogiSidePlacement,
  shogiSides,
  shogiSquareName,
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
  royalKing?: boolean;
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

const boardSizing = [
  "[--shogi-board-margin:0.013]",
  "[--shogi-coordinate-space:calc(var(--shogi-board-width)_*_var(--shogi-board-margin))]",
  "[--shogi-piece-ratio:calc((1_-_2_*_var(--shogi-board-margin))_*_var(--shogi-piece-scale)_/_9)]",
  "[--shogi-piece-width:calc(var(--shogi-board-width)_*_var(--shogi-piece-ratio))]",
  "[--shogi-board-with-hands-ratio:calc(1_+_2_*_var(--shogi-piece-ratio)_*_148_/_140)]",
  "grid w-full min-h-full content-center justify-center gap-2 py-2",
].join(" ");

const coordinateLabelClasses =
  "pointer-events-none absolute grid place-items-center select-none font-semibold leading-none tabular-nums text-[#3b260c] text-[length:var(--shogi-coordinate-space)]";

const standardLayout = [
  "[--player-height:68px] [@media(max-width:767px)]:[--player-height:52px]",
  "[--shogi-fixed-height:72px] [@media(max-width:767px)]:[--shogi-fixed-height:32px]",
  "[--shogi-board-width:max(var(--board-min-size,160px),min(600px,100cqw,calc((100cqh_-_2_*_var(--player-height)_-_var(--shogi-fixed-height)_-_var(--board-status-space,0px))_/_var(--shogi-board-with-hands-ratio))))]",
  "[--seat-width:var(--shogi-board-width)] grid-cols-[var(--shogi-board-width)] grid-rows-[auto_auto_auto]",
  "[grid-template-areas:'top'_'board'_'bottom'] [@media(max-width:767px)]:gap-1 [@media(max-width:767px)]:py-1",
].join(" ");

const fourPlayerLayout = [
  "[--player-height:60px] [@media(max-width:767px)]:[--player-height:48px]",
  "[--shogi-side-width:clamp(140px,21cqw,220px)] [--seat-width:var(--shogi-side-width)] [@media(max-width:767px)]:[--seat-width:100%]",
  "[--shogi-board-width:max(var(--board-min-size,180px),min(458px,calc(100cqw_-_2_*_var(--shogi-side-width)_-_16px),calc(100cqh_-_2_*_var(--player-height)_-_32px_-_var(--board-status-space,0px))))]",
  "[@media(max-width:767px)]:[--shogi-board-width:max(0px,min(100cqw,calc((100cqh_-_2_*_var(--player-height)_-_2_*_6px_-_4_*_2px_-_var(--board-status-space,0px))_/_var(--shogi-board-with-hands-ratio))))]",
  "grid-cols-[var(--shogi-side-width)_var(--shogi-board-width)_var(--shogi-side-width)] grid-rows-[var(--player-height)_var(--shogi-board-width)_var(--player-height)]",
  "[grid-template-areas:'top_top_top'_'left_board_right'_'bottom_bottom_bottom']",
  "[@media(max-width:767px)]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] [@media(max-width:767px)]:grid-rows-[auto_auto_auto]",
  "[@media(max-width:767px)]:[grid-template-areas:'left_top'_'board_board'_'bottom_right'] [@media(max-width:767px)]:gap-[2px] [@media(max-width:767px)]:content-start [@media(max-width:767px)]:py-0",
].join(" ");

const groupClasses = {
  top: "[grid-area:top] w-fit justify-self-center flex-row-reverse items-center [@media(max-width:767px)]:w-full [@media(max-width:767px)]:flex-col",
  bottom:
    "[grid-area:bottom] w-fit justify-self-center flex-row items-center [@media(max-width:767px)]:w-full [@media(max-width:767px)]:flex-col-reverse",
  left: "[grid-area:left] flex-col items-end justify-start h-full [@media(max-width:767px)]:h-auto [@media(max-width:767px)]:items-center",
  right:
    "[grid-area:right] flex-col-reverse items-start justify-start h-full [@media(max-width:767px)]:h-auto [@media(max-width:767px)]:items-center",
} as const;

export type FourShogiBoardLayoutProps<A extends FourShogiAction = LegacyAction> = {
  game: ShogiBoardView;
  eliminatedHands?: EliminatedHands;
  pendingAction?: A;
  viewerSide: Side;
  interactionSide?: Side;
  revision: Revision;
  canPlay: boolean;
  promotionController?: PromotionController;
  editing?: { selected: Position | null; onSelect(position: Position): void };
  legalActions: readonly A[];
  threePlayerAttackForbiddenActions?: readonly A[];
  checkState?: Readonly<Partial<Record<Side, boolean>>>;
  onAction(action: A): boolean | void;
  playerCards: Readonly<Partial<Record<Side, ReactNode>>>;
  standard?: boolean;
  formationNotice?: string;
  onFormationNoticeDismiss?: () => void;
};

export function FourShogiBoardLayout({
  game,
  eliminatedHands = {},
  standard = false,
  pendingAction,
  viewerSide,
  interactionSide = viewerSide,
  revision,
  canPlay,
  promotionController,
  editing,
  legalActions,
  threePlayerAttackForbiddenActions = [],
  checkState,
  onAction,
  playerCards,
  formationNotice,
  onFormationNoticeDismiss,
}: FourShogiBoardLayoutProps<FourShogiAction>) {
  const layout = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void prepareShogiAssets(standard);
  }, [standard]);
  const trace = useRef<PointerTrace | null>(null);
  const suppressClick = useRef(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const eliminated = game.eliminations.map((entry) => entry.side);
  const enabled =
    canPlay &&
    game.status === "playing" &&
    !editing &&
    game.turn === interactionSide &&
    !eliminated.includes(interactionSide);
  const selectableActions = [...legalActions, ...threePlayerAttackForbiddenActions];
  const localPromotion = useLocalPromotion(`${revision}:${interactionSide}`, legalActions, enabled);
  const promotion = promotionController ?? localPromotion;
  const promotionChoices = promotion.choices;
  const sent = useRef(false);
  const [interactionScope, setInteractionScope] = useState({
    revision,
    viewerSide,
    interactionSide,
    enabled,
  });

  // 局面や操作権限の変更と同じ描画で解除し、以前の選択が再表示されることを防ぎます。
  if (
    interactionScope.revision !== revision ||
    interactionScope.viewerSide !== viewerSide ||
    interactionScope.interactionSide !== interactionSide ||
    interactionScope.enabled !== enabled
  ) {
    setInteractionScope({ revision, viewerSide, interactionSide, enabled });
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
        ?.querySelector<HTMLButtonElement>(`[data-square="${shogiSquareName(from)}"]`)
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
  }, [revision, viewerSide, interactionSide, enabled]);

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
    onFormationNoticeDismiss?.();
    setSelected(
      selection && shogiSameSelection(selection, next) ? null : { selection: next, revision },
    );
  }

  function send(action: FourShogiAction): void {
    if (!enabled || sent.current) return;
    sent.current = true;
    cancelSelection();
    if (onAction(action) === false) sent.current = false;
  }

  function chooseDestination(source: ShogiSelection, to: Position): void {
    if (!enabled) return;
    onFormationNoticeDismiss?.();
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
    onFormationNoticeDismiss?.();
    suppressClick.current = false;
    const image = event.currentTarget.querySelector("img");
    trace.current = {
      ...source,
      pointerId: event.pointerId,
      element: event.currentTarget,
      start: { x: event.clientX, y: event.clientY },
      moved: false,
      width: image ? Number.parseFloat(getComputedStyle(image).width) || image.clientWidth : 30,
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
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLButtonElement>("button[data-square]");
    const name = target?.dataset.square;
    if (!target || !name || !grid.current.contains(target)) return;
    chooseDestination(active.selection, {
      x: name.charCodeAt(0) - "A".charCodeAt(0),
      y: Number(name[1]) - 1,
    });
  }

  function cancelPointer(): void {
    suppressClick.current = true;
    cancelSelection();
  }

  function lostPointer(): void {
    if (trace.current) cancelPointer();
  }

  function hand(
    side: Side,
    direction: ShogiPieceDirection,
    vertical = false,
    reverseOrder?: boolean,
  ) {
    const availableKinds =
      enabled && side === interactionSide
        ? selectableActions.flatMap((action) =>
            action.type === "dropPiece" ? [action.pieceKind] : [],
          )
        : [];
    return (
      <FourShogiHand
        hand={
          (!standard && eliminated.includes(side)
            ? (eliminatedHands[side] ?? game.hands[side])
            : game.hands[side]) ?? {}
        }
        standard={standard}
        label={`${standard ? (side === "south" ? "先手" : "後手") : shogiSideNames[side]}の持ち駒`}
        direction={direction}
        reverseOrder={reverseOrder}
        vertical={vertical}
        selectedKind={
          side === interactionSide && selection?.type === "dropPiece" ? selection.pieceKind : null
        }
        availableKinds={availableKinds}
        draggingKind={
          side === interactionSide && drag?.selection.type === "dropPiece"
            ? drag.selection.pieceKind
            : null
        }
        onSelect={(kind, event) => {
          if (!availableKinds.includes(kind)) return;
          if (event.detail === 0) suppressClick.current = false;
          select({ type: "dropPiece", pieceKind: kind });
        }}
        onPointerDown={(event, kind) =>
          availableKinds.includes(kind) &&
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
  const pieceScale = standard ? 0.86 : 0.82;
  const sideways = viewerSide === "west" || viewerSide === "east";
  const coordinates = Array.from({ length: 9 }, (_, index) => {
    const top = shogiBoardPosition({ x: index, y: 0 }, viewerSide);
    const right = shogiBoardPosition({ x: 8, y: index }, viewerSide);
    return {
      top: sideways ? shogiNotationRank(top.y) : shogiNotationFile(top.x),
      right: sideways ? shogiNotationFile(right.x) : shogiNotationRank(right.y),
    };
  });
  // カード2段・持ち駒2段・余白を除いた高さに収めます。
  // 持ち駒の高さも盤の幅に比例するため、盤と駒2段の比率を合わせて計算します。
  return (
    <RoomBoardGroup
      ref={layout}
      data-testid="shogi-board-layout"
      style={{ "--shogi-piece-scale": pieceScale } as CSSProperties}
      className={`${boardSizing} ${standard ? standardLayout : fourPlayerLayout}`}
    >
      {(standard ? (["south", "north"] as const) : shogiSides).map((side) => {
        const placement = shogiSidePlacement(side, viewerSide);
        const direction = shogiPieceDirection(side, viewerSide);
        const vertical = placement === "left" || placement === "right";
        const reverseMobileHandOrder = placement === "left" || placement === "top";
        return (
          <div
            key={side}
            data-side={side}
            data-board-position={placement}
            className={`flex min-w-0 gap-[6px] [@media(max-width:767px)]:gap-[2px] ${standard ? (placement === "top" ? "flex-col w-full items-center [grid-area:top]" : "flex-col-reverse w-full items-center [grid-area:bottom]") : groupClasses[placement]}`}
          >
            <div className="w-[var(--seat-width)] shrink-0 min-w-0">{playerCards[side]}</div>
            <div
              className={
                standard
                  ? "flex w-full justify-center"
                  : "hidden shrink-0 min-w-0 [@media(min-width:768px)]:flex justify-center"
              }
            >
              {hand(side, direction, vertical)}
            </div>
            {!standard && (
              <div className="flex w-full justify-center [@media(min-width:768px)]:hidden">
                {hand(side, direction, false, reverseMobileHandOrder)}
              </div>
            )}
          </div>
        );
      })}
      <div
        data-testid="shogi-board"
        className="[grid-area:board] relative w-[var(--shogi-board-width)] aspect-square place-self-center bg-[#cb8900] bg-cover bg-center shadow-[0_8px_24px_#71531c25]"
        style={{ backgroundImage: `url("${boardImage}")` }}
        role="group"
        aria-label={standard ? "将棋の盤面" : "四人将棋の盤面"}
      >
        <div
          ref={grid}
          className="absolute inset-[calc(var(--shogi-board-margin)*100%)] isolate grid grid-cols-9 grid-rows-9"
        >
          <div
            aria-hidden="true"
            data-testid="shogi-coordinates-top"
            className={`${coordinateLabelClasses} bottom-full left-0 h-[var(--shogi-coordinate-space)] w-full grid-cols-9`}
          >
            {coordinates.map(({ top }) => (
              <span key={top}>{top}</span>
            ))}
          </div>
          <div
            aria-hidden="true"
            data-testid="shogi-coordinates-right"
            className={`${coordinateLabelClasses} top-0 left-full h-full w-[var(--shogi-coordinate-space)] grid-rows-9`}
          >
            {coordinates.map(({ right }) => (
              <span key={right}>{right}</span>
            ))}
          </div>
          {Array.from({ length: 81 }, (_, index) => {
            const x = index % 9;
            const y = Math.floor(index / 9);
            const position = shogiBoardPosition({ x, y }, viewerSide);
            const squareName = shogiSquareName(position);
            const star = (x === 3 || x === 6) && (y === 3 || y === 6);
            const highlightBounds = `absolute top-px left-px ${x === 8 ? "right-px" : "right-0"} ${y === 8 ? "bottom-px" : "bottom-0"} pointer-events-none`;
            const piece = game.board[position.y][position.x];
            const dead = !standard && piece !== null && eliminated.includes(piece.side);
            const canSelect =
              enabled &&
              piece?.side === interactionSide &&
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
              (selection?.type === "movePiece" && shogiSamePosition(selection.from, position)) ||
              !!(editing?.selected && shogiSamePosition(editing.selected, position));
            const lastFrom =
              lastAction?.type === "movePiece" && shogiSamePosition(lastAction.from, position);
            const lastTo = lastAction && shogiSamePosition(lastAction.to, position);
            const pendingTo = pendingAction && shogiSamePosition(pendingAction.to, position);
            const dragging =
              drag?.selection.type === "movePiece" &&
              shogiSamePosition(drag.selection.from, position);
            const checked = piece?.kind === "king" && !dead && checkState?.[piece.side];
            const pieceLabel = piece
              ? `${shogiSideNames[piece.side]}の${piece.kind === "king" && dead ? "裏王" : piece.promoted ? (piece.kind === "rook" ? "龍" : piece.kind === "bishop" ? "馬" : piece.kind === "silver" ? "成銀" : piece.kind === "knight" ? "成桂" : piece.kind === "lance" ? "成香" : "と金") : shogiPieceNames[piece.kind]}`
              : "空き";
            return (
              <button
                key={index}
                type="button"
                disabled={!editing && !canSelect && !destination}
                data-square={squareName}
                data-selected={selectedSquare || undefined}
                data-legal-destination={destination || undefined}
                data-three-player-attack-forbidden={forbiddenDestination || undefined}
                data-last-move={lastTo ? "to" : lastFrom ? "from" : undefined}
                data-pending-move={pendingTo || undefined}
                data-check={checked || undefined}
                data-dragging={dragging || undefined}
                aria-label={`${squareName}：${pieceLabel}${dead && piece?.kind !== "king" ? "、脱落した駒" : ""}${canSelect ? "、選択できます" : ""}${destination ? "、移動できます" : ""}${forbiddenDestination ? "、三人攻撃のため着手できません" : ""}${checked ? "、王手" : ""}${lastFrom ? "、直前の移動元" : ""}${lastTo ? "、直前の移動先" : ""}${pendingTo ? "、未確定の移動先" : ""}、棋譜座標${shogiNotationSquare(position)}`}
                aria-pressed={
                  !!selectedSquare ||
                  !!(editing?.selected && shogiSamePosition(editing.selected, position))
                }
                className={`group/shogi-piece relative grid place-items-center min-w-0 min-h-0 w-full h-full p-0 rounded-none border-0 bg-transparent focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-[-3px] ${canSelect ? "touch-none" : "touch-auto"}${canSelect || destination || editing ? " cursor-pointer" : " cursor-default"}`}
                onClick={(event) => {
                  if (event.detail === 0) suppressClick.current = false;
                  if (editing) editing.onSelect(position);
                  else onSquareClick(position, !!canSelect);
                }}
                onPointerDown={(event) => {
                  if (piece && canSelect)
                    startPointer(event, {
                      selection: { type: "movePiece", from: position },
                      kind: piece.kind,
                      promoted: piece.promoted,
                      direction: shogiPieceDirection(piece.side, viewerSide),
                      royalKing: standard && piece.side === "south",
                    });
                }}
                onPointerMove={movePointer}
                onPointerUp={endPointer}
                onPointerCancel={cancelPointer}
                onLostPointerCapture={lostPointer}
              >
                {pendingTo && (
                  <span
                    aria-hidden="true"
                    className={`${highlightBounds} box-border border-2 border-dashed border-[#9c6f14]`}
                  />
                )}
                <span
                  aria-hidden="true"
                  data-testid="shogi-square-highlight"
                  className={`${highlightBounds} ${checked ? "bg-[#e93f3540] shadow-[inset_0_0_0_2px_#b84625]" : selectedSquare ? "bg-[#ffeb8980] shadow-[inset_0_0_0_2px_#9c6f14]" : lastFrom ? "bg-[#54361870]" : canSelect || destination ? "group-hover/shogi-piece:bg-[#fff0b735]" : ""}${lastTo ? " ring-[3px] ring-inset ring-[#ffad32]" : ""}`}
                />
                {piece && (
                  <span
                    className={`relative pointer-events-none ${dead && piece.kind !== "king" ? "opacity-55" : ""} ${dragging ? "invisible" : canSelect || selectedSquare ? shogiPieceLiftClasses(!!selectedSquare) : ""}`}
                  >
                    <ShogiPiece
                      royalKing={standard && piece.side === "south"}
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
                <span
                  aria-hidden="true"
                  className={`absolute inset-0 z-[1] pointer-events-none border-solid border-[#3b260c] border-t border-l ${x === 8 ? "border-r" : "border-r-0"} ${y === 8 ? "border-b" : "border-b-0"}`}
                />
                {star && (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 left-0 z-[2] size-[clamp(3px,14%,8px)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#3b260c] pointer-events-none"
                  />
                )}
              </button>
            );
          })}
          {formationNotice && !selection && !drag && !promotionChoices && (
            <div
              key={formationNotice}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="shogi-formation-notice"
              className="absolute left-1/2 top-[83.333333%] z-10 -translate-x-1/2 -translate-y-1/2 pointer-events-none select-none whitespace-nowrap rounded-lg bg-[#3d291ee6] px-[0.5em] py-[0.25em] text-white shadow-md text-[clamp(0px,calc(var(--shogi-board-width)_*_0.047),24px)] motion-safe:animate-[shogi-formation-fade_2s_ease-in-out_both]"
            >
              {formationNotice}
            </div>
          )}
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
          <ShogiPiece
            kind={drag.kind}
            promoted={drag.promoted}
            direction={drag.direction}
            royalKing={drag.royalKing}
          />
        </div>
      )}
      {promotionChoices && (
        <ShogiPromotionChoice
          choices={promotionChoices}
          kind={game.board[promotionChoices[0].from.y][promotionChoices[0].from.x]!.kind}
          viewerSide={viewerSide}
          interactionSide={interactionSide}
          grid={grid}
          pieceScale={pieceScale}
          onChoose={send}
        />
      )}
    </RoomBoardGroup>
  );
}
