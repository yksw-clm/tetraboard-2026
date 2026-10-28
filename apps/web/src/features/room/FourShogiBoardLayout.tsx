import {
  FourShogiBoardLayout as SharedBoard,
  type FourShogiBoardLayoutProps as SharedProps,
} from "@tetraboard/shogi-ui/board";
import type { FourShogiAction, Side } from "./shogiUiTypes";
import type { FourShogiAction as LegacyAction } from "@tetraboard/four-shogi";
import { useShogiPromotion, type ShogiPromotionContext } from "./useShogiPromotion";

export type FourShogiBoardLayoutProps<A extends FourShogiAction = LegacyAction> = Omit<
  SharedProps<A>,
  "promotionController" | "interactionSide" | "editing"
> & {
  promotionContext?: ShogiPromotionContext;
};

export function FourShogiBoardLayout({
  promotionContext,
  ...props
}: FourShogiBoardLayoutProps<FourShogiAction>) {
  const eliminated = props.game.eliminations.map((entry) => entry.side);
  const enabled =
    props.canPlay &&
    props.game.status === "playing" &&
    props.game.turn === props.viewerSide &&
    !eliminated.includes(props.viewerSide as Side);
  const promotion = useShogiPromotion(promotionContext, props.legalActions, enabled);
  return <SharedBoard {...props} promotionController={promotion} />;
}
