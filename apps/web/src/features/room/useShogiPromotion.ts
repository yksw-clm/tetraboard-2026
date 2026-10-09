import type { FourShogiAction, Position, Side } from "./shogiUiTypes";
import { fourShogiActionSchema } from "@tetraboard/protocol";
import { useEffect, useRef, useState } from "react";
import { shogiActionChoices } from "./shogiBoardPresentation";

export type ShogiPromotionScope = {
  instanceId: string;
  playerId: string;
  roundId: string;
  positionRevision: number;
  side: Side;
};
export type ShogiPromotionContext = ShogiPromotionScope & { confirmed: boolean };
type PromotionIntent = ShogiPromotionScope & { from: Position; to: Position };

function storageKey(scope: ShogiPromotionScope): string {
  return `tetraboard:shogi-promotion:${scope.instanceId}:${scope.playerId}`;
}

function readPromotion(key: string | null): PromotionIntent | null {
  if (key === null) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    const action = fourShogiActionSchema.safeParse({
      type: "movePiece",
      from: value.from,
      to: value.to,
      promote: true,
    });
    if (
      !action.success ||
      action.data.type !== "movePiece" ||
      typeof value.instanceId !== "string" ||
      typeof value.playerId !== "string" ||
      typeof value.roundId !== "string" ||
      !Number.isSafeInteger(value.positionRevision) ||
      value.positionRevision < 0 ||
      !["south", "west", "north", "east"].includes(value.side)
    )
      return null;
    return { ...value, from: action.data.from, to: action.data.to };
  } catch {
    return null;
  }
}

function removePromotion(key: string | null): void {
  if (key === null) return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // 保存領域が使えない場合も、盤面上の操作は継続します。
  }
}

function sameScope(intent: PromotionIntent, scope: ShogiPromotionScope): boolean {
  return (
    intent.instanceId === scope.instanceId &&
    intent.playerId === scope.playerId &&
    intent.roundId === scope.roundId &&
    intent.positionRevision === scope.positionRevision &&
    intent.side === scope.side
  );
}

export function useShogiPromotion(
  context: ShogiPromotionContext | undefined,
  legalActions: readonly FourShogiAction[],
  enabled: boolean,
) {
  const key = context ? storageKey(context) : null;
  const [stored, setStored] = useState(() => ({ key, intent: readPromotion(key) }));
  const previousKey = useRef(key);
  if (stored.key !== key) setStored({ key, intent: readPromotion(key) });
  const intent = stored.key === key ? stored.intent : null;
  const matches = intent !== null && context !== undefined && sameScope(intent, context);
  const candidates = matches
    ? shogiActionChoices(legalActions, { type: "movePiece", from: intent.from }, intent.to)
    : [];
  const choices = candidates.filter((action) => action.type === "movePiece");
  const valid =
    choices.length === 2 && choices.some((a) => a.promote) && choices.some((a) => !a.promote);

  // 接続待ちは取消にせず、同じ局面の認証済み合法手を確認してから復元します。
  if (intent && (!matches || (context?.confirmed && !valid))) {
    setStored({ key, intent: null });
  }
  useEffect(() => {
    if (previousKey.current !== key) removePromotion(previousKey.current);
    previousKey.current = key;
    if (!intent) removePromotion(key);
  }, [key, intent]);

  function clear(): void {
    removePromotion(key);
    setStored({ key, intent: null });
  }

  function open(actions: readonly FourShogiAction[]): void {
    const action = actions.find((candidate) => candidate.type === "movePiece");
    if (!context || !action || action.type !== "movePiece") return;
    const next: PromotionIntent = {
      instanceId: context.instanceId,
      playerId: context.playerId,
      roundId: context.roundId,
      positionRevision: context.positionRevision,
      side: context.side,
      from: action.from,
      to: action.to,
    };
    try {
      sessionStorage.setItem(storageKey(context), JSON.stringify(next));
    } catch {
      // 再読み込みの復元だけを諦め、その場での選択は表示します。
    }
    setStored({ key, intent: next });
  }

  return { choices: enabled && context?.confirmed && valid ? choices : null, open, clear };
}
