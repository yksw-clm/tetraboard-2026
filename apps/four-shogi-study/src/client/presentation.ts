import type { AiEvaluation, AiLineStep } from "@tetraboard/four-shogi/ai";
import type { FourShogiAction, FourShogiState, Side } from "@tetraboard/four-shogi";
import { shogiNotationPiece, shogiNotationSquare } from "@tetraboard/shogi-ui/notation";
import type { StudyNode } from "../shared/model";

export const sideNames: Record<Side, string> = { south: "南", west: "西", north: "北", east: "東" };
export const sideColors: Record<Side, string> = {
  south: "#3d7454",
  west: "#b27a35",
  north: "#6478ab",
  east: "#b16878",
};
export const sideOrder: readonly Side[] = ["south", "west", "north", "east"];
export function scoreValue(evaluation: AiEvaluation | null, side: Side): number | null {
  return evaluation?.values[side].heuristicScore ?? null;
}
export function scoreLabel(evaluation: AiEvaluation | null, side: Side): string {
  if (!evaluation) return "—";
  if (evaluation.evaluationKind === "terminal") {
    const rank = evaluation.ranks.find((entry) => entry.side === side)?.rank;
    return rank ? `${rank}位` : "終局";
  }
  const value = scoreValue(evaluation, side);
  return value === null
    ? "—"
    : `${value >= 0 ? "+" : ""}${Math.round(value).toLocaleString("ja-JP")}`;
}
export function actionLabel(action: FourShogiAction, state: FourShogiState): string {
  const piece =
    action.type === "dropPiece"
      ? { kind: action.pieceKind, promoted: false }
      : state.board[action.from.y][action.from.x];
  return `${shogiNotationSquare(action.to)}${piece ? shogiNotationPiece(piece) : "駒"}${action.type === "dropPiece" ? "打" : action.promote && !piece?.promoted ? "成" : ""}`;
}
export function lineLabel(step: AiLineStep): string {
  const action = step.action;
  return `${sideNames[step.side]} ${shogiNotationSquare(action.to)}${action.type === "dropPiece" ? `${shogiNotationPiece({ kind: action.pieceKind, promoted: false })}打` : `${action.promote ? "成" : ""}（${shogiNotationSquare(action.from)}から）`}`;
}
export function ancestorIds(nodes: readonly StudyNode[], currentId: string): string[] {
  const lookup = new Map(nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  let node = lookup.get(currentId);
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    path.push(node.id);
    seen.add(node.id);
    node = node.parentId ? lookup.get(node.parentId) : undefined;
  }
  return path.reverse();
}
export function orderedTree(
  nodes: readonly StudyNode[],
): { node: StudyNode; level: number; branch: boolean }[] {
  const children = new Map<string | null, StudyNode[]>();
  for (const node of nodes)
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const stack = (children.get(null) ?? [])
    .toReversed()
    .map((node) => ({ node, level: 0, branch: false }));
  const result = [];
  while (stack.length) {
    const entry = stack.pop()!;
    result.push(entry);
    const next = children.get(entry.node.id) ?? [];
    for (let index = next.length - 1; index >= 0; index--)
      stack.push({
        node: next[index],
        level: entry.level + (index > 0 ? 1 : 0),
        branch: index > 0,
      });
  }
  return result;
}
