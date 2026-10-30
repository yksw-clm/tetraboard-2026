import type { FourShogiAction } from "@tetraboard/four-shogi";
import type { StudySnapshot } from "../contracts";
import { actionLabel } from "./presentation";

function sameAction(a: FourShogiAction, b: FourShogiAction): boolean {
  return (
    a.to.x === b.to.x &&
    a.to.y === b.to.y &&
    (a.type === "movePiece" && b.type === "movePiece"
      ? a.from.x === b.from.x && a.from.y === b.from.y && a.promote === b.promote
      : a.type === "dropPiece" && b.type === "dropPiece" && a.pieceKind === b.pieceKind)
  );
}

/** 公開済み比較の首位だけを表示し、未完成の根や別局面から最善手を推定しません。 */
export function studyBestMove(snapshot: StudySnapshot, connected: boolean) {
  const hidden = (message: string) => ({ move: undefined, message });
  const { study, position, analysis, live } = snapshot;
  if (!connected) return hidden("局面・解析の更新を確認中");
  if (live?.follow && !["live", "finished"].includes(live.status))
    return hidden("ライブ局面の同期を確認中");
  if (!analysis) return hidden("最善手の解析結果はありません");
  const targetHash = analysis.analysisStateHash ?? (analysis.focus ? null : analysis.stateHash);
  if (
    position.state.status !== "playing" ||
    analysis.nodeId !== study.currentNodeId ||
    analysis.stateHash !== position.stateHash ||
    targetHash !== position.stateHash ||
    (analysis.focus &&
      (analysis.focus.status !== "ready" ||
        analysis.focus.conditional ||
        analysis.focus.prefix.length > 0 ||
        analysis.focus.sourceStateHash !== position.stateHash ||
        analysis.focus.analysisStateHash !== position.stateHash ||
        analysis.focus.side !== position.state.turn))
  )
    return hidden("現在局面の最善手は未確認");
  if (analysis.status === "cancelled" || analysis.status === "error")
    return hidden("完成済みの最善手はありません");
  const first = analysis.candidates[0];
  const action = analysis.recommendedAction;
  if (
    !Number.isSafeInteger(analysis.completedDepth) ||
    analysis.completedDepth < 1 ||
    analysis.completion?.normalResult === "incomplete" ||
    !first ||
    first.completedDepth !== analysis.completedDepth ||
    first.comparisonKind !== "uniform_depth" ||
    first.line[0]?.side !== position.state.turn ||
    !sameAction(first.line[0].action, first.action) ||
    !action ||
    !sameAction(first.action, action) ||
    (analysis.analysisRecommendedAction &&
      !sameAction(analysis.analysisRecommendedAction, action)) ||
    !snapshot.legalActions.some((legal) => sameAction(legal, action))
  )
    return hidden(
      analysis.status === "running" ? "最善手を計算中" : "完成済みの最善手はありません",
    );
  const state =
    analysis.status === "completed"
      ? "最善手（探索完了）"
      : analysis.status === "paused"
        ? "暫定最善手（停止中）"
        : "暫定最善手";
  const message = `${state}・深さ${analysis.completedDepth}まで完成：${actionLabel(action, position.state)}`;
  return { move: { action, label: message }, message };
}
