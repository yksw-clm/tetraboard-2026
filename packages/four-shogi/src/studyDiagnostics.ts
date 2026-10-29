import type { AiEvaluation, AiLineStep } from "./aiTypes";
import type { FourShogiAction, FourShogiState, Side } from "./types";

export type StudyTraceNode = {
  rootIndex: number;
  taskDepth: number;
  policy: { phase: "broad" | "deep"; width: number; ownWidth: number } | null;
  path: readonly string[];
  key: string;
  remaining: number;
  extra: number;
  ply: number;
  turn: Side | null;
};
export type StudySelectionRow = {
  index: number;
  action: FourShogiAction;
  orderRank: number | null;
  orderScore: number | null;
  staticRank: number | null;
  evaluation: AiEvaluation | null;
  selected: boolean;
  reason:
    | "ordering_filter"
    | "broad_filter"
    | "extension_filter"
    | "top_k"
    | "selected"
    | "promotion_reserve"
    | "checking_reserve"
    | "diagnostic_include";
};
export type StudyTraceEvent = StudyTraceNode &
  (
    | {
        type: "selection";
        state: FourShogiState;
        rows: StudySelectionRow[];
        checked: boolean;
        tacticalOnly: boolean;
      }
    | {
        type: "return";
        reason: "terminal" | "horizon" | "cache" | "searched";
        evaluation: AiEvaluation;
        line: readonly AiLineStep[];
      }
    | {
        type: "child";
        action: FourShogiAction;
        evaluation: AiEvaluation;
      }
  );
/** CLI専用の観測・一節点介入。アプリの設定やworkerの起動オプションへ渡しません。 */
export type StudySearchDiagnostics = {
  observe?: (event: StudyTraceEvent) => void;
  disableBranchCache?: boolean;
  extendDeepLeaves?: boolean;
  watchPaths?: readonly (readonly string[])[];
  includeAt?: { key: string; path: readonly string[]; action: FourShogiAction };
};

export function studyTraceAction(side: Side, action: FourShogiAction): string {
  return JSON.stringify([side, action]);
}
