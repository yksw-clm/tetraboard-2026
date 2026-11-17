import {
  FourShogiBoardLayout as SharedBoard,
  type FourShogiBoardLayoutProps as SharedProps,
} from "@tetraboard/shogi-ui/board";
import type { FourShogiAction, Side } from "./shogiUiTypes";
import type { FourShogiAction as LegacyAction } from "@tetraboard/four-shogi";
import { useShogiPromotion, type ShogiPromotionContext } from "./useShogiPromotion";
import { useBoardMotion } from "./useBoardMotion";
import type { BoardMotionContext } from "./boardMotion";

export type FourShogiBoardLayoutProps<A extends FourShogiAction = LegacyAction> = Omit<
  SharedProps<A>,
  "promotionController" | "interactionSide" | "editing" | "boardRef"
> & {
  promotionContext?: ShogiPromotionContext;
  motion?: BoardMotionContext | null;
};

export function FourShogiBoardLayout({
  promotionContext,
  motion,
  ...props
}: FourShogiBoardLayoutProps<FourShogiAction>) {
  const boardRef = useBoardMotion({
    context: motion,
    orientation: props.viewerSide,
    cells: props.game.board.map((row) =>
      row.map((piece) => piece && `${piece.id}:${piece.side}:${piece.kind}:${piece.promoted}`),
    ),
    destination: props.pendingAction?.to ?? props.game.lastMove?.action.to ?? null,
    optimistic: props.pendingAction !== undefined,
  });
  const eliminated = props.game.eliminations.map((entry) => entry.side);
  const enabled =
    props.canPlay &&
    props.game.status === "playing" &&
    props.game.turn === props.viewerSide &&
    !eliminated.includes(props.viewerSide as Side);
  const promotion = useShogiPromotion(promotionContext, props.legalActions, enabled);
  return <SharedBoard {...props} boardRef={boardRef} promotionController={promotion} />;
}
