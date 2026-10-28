import { useState } from "react";
import type { FourShogiAction } from "./shogiUiTypes";

type Move = Extract<FourShogiAction, { type: "movePiece" }>;
export type PromotionController = {
  choices: Move[] | null;
  open(actions: readonly FourShogiAction[]): void;
  clear(): void;
};

export function useLocalPromotion(
  scope: string,
  legalActions: readonly FourShogiAction[],
  enabled: boolean,
): PromotionController {
  const [pending, setPending] = useState<{ scope: string; choices: Move[] } | null>(null);
  const valid =
    enabled &&
    pending?.scope === scope &&
    pending.choices.length === 2 &&
    pending.choices.every((choice) =>
      legalActions.some((action) => JSON.stringify(action) === JSON.stringify(choice)),
    );
  // 別局面から戻ったときに、破棄済みの成り選択を復活させません。
  if (pending && !valid) setPending(null);
  return {
    choices: valid && pending ? pending.choices : null,
    open(actions) {
      setPending({
        scope,
        choices: actions.filter((action): action is Move => action.type === "movePiece"),
      });
    },
    clear() {
      setPending(null);
    },
  };
}
