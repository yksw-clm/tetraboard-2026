import type { StudyAnalysisView, StudySnapshot } from "../contracts";

export function newerAnalysis(
  current: StudyAnalysisView | null,
  incoming: StudyAnalysisView | null,
): StudyAnalysisView | null {
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.generation < current.generation) return current;
  if (incoming.generation > current.generation) return incoming;
  if (incoming.id !== current.id) return current;
  if (incoming.work < current.work || incoming.elapsedMs < current.elapsedMs) return current;
  if (["completed", "cancelled", "error"].includes(current.status) && incoming.status === "running")
    return current;
  if (current.status === "paused" && incoming.status === "running") return current;
  return incoming;
}
export function mergeStudySnapshot(
  current: StudySnapshot | null,
  incoming: StudySnapshot,
): StudySnapshot {
  if (!current || current.study.id !== incoming.study.id) return incoming;
  if (current.study.revision > incoming.study.revision) return current;
  if (
    current.study.revision === incoming.study.revision &&
    current.position.stateHash === incoming.position.stateHash &&
    current.study.currentNodeId === incoming.study.currentNodeId
  ) {
    return { ...incoming, analysis: newerAnalysis(current.analysis, incoming.analysis) };
  }
  return incoming;
}
