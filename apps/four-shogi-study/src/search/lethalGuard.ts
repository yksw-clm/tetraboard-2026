import { getAnalysisLegalActions, type AnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { getActiveSides, type FourShogiAction, type Side } from "@tetraboard/four-shogi";
import type { AiCandidate } from "@tetraboard/four-shogi/ai";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";
import { encodeAction } from "../../../../packages/four-shogi/src/actionEncoding";
import { pieceValue } from "../../../../packages/four-shogi/src/cpuEvaluation";
import {
  proveFiniteAction,
  finiteLossWitness,
  type SafetyProof,
  type FiniteStatus,
} from "../../../../packages/four-shogi/src/finiteSurvival";

export type LethalGuardMode = "off" | "observe" | "experimental";
export type GuardSelection = "top3" | "top5" | "top3-reserve" | "all";
export type LethalGuardOptions = {
  mode: LethalGuardMode;
  budgetMs?: number;
  selection?: GuardSelection;
  horizon?: number;
  maxTransitions?: number;
  maxWork?: number;
  maxBytes?: number;
};
export type GuardRow = {
  action: FourShogiAction;
  actionId: number;
  maxNRank: number | null;
  source: "maxn" | "static-reserve" | "diagnostic-only";
  candidate: AiCandidate | null;
  status: FiniteStatus;
  completedWithinBudget: boolean;
  proof: SafetyProof | null;
  witness: FourShogiAction[] | null;
};
export type LethalGuardReport = {
  normalElapsedMs?: number;
  totalBudgetMs?: number;
  maxNCompletedDepth?: number;
  version: "finite-lethal-reply-guard-v1";
  mode: LethalGuardMode;
  stateHash: string;
  horizon: number;
  selection: GuardSelection;
  budgetMs: number;
  elapsedMs: number;
  work: number;
  transitions: number;
  estimatedBytes: number;
  parentRssBytes: number;
  originalCandidates: readonly AiCandidate[];
  rows: GuardRow[];
  originalAction: FourShogiAction | null;
  hypotheticalAction: FourShogiAction | null;
  changed: boolean;
  wouldChange: boolean;
  reason: string;
};

export function chooseGuardCandidate(
  candidates: readonly AiCandidate[],
  rows: readonly GuardRow[],
  root: Side,
): AiCandidate | null {
  const first = candidates[0];
  if (!first) return null;
  if (
    first.evaluation?.evaluationKind === "terminal" &&
    first.evaluation.values[root].primary === 1
  )
    return first;
  const incumbent = rows.find((row) => row.actionId === encodeAction(first.action));
  if (
    incumbent?.status !== "unsafe" ||
    !incumbent.completedWithinBudget ||
    incumbent.proof?.status !== "unsafe" ||
    incumbent.proof.root !== root
  )
    return first;
  // unknownや未検査手を危険と推定せず、証明済みの首位と代替だけを比較します。
  return (
    rows
      .filter(
        (row) =>
          row.status === "safe" &&
          row.completedWithinBudget &&
          row.candidate &&
          row.proof?.status === "safe" &&
          row.proof.root === root &&
          row.proof.horizon === incumbent.proof!.horizon &&
          row.proof.inputHash === incumbent.proof!.inputHash,
      )
      .sort((a, b) => (a.maxNRank ?? Infinity) - (b.maxNRank ?? Infinity))[0]?.candidate ?? first
  );
}

function replyOrder(position: AnalysisPosition, actions: readonly FourShogiAction[], root: Side) {
  const score = (action: FourShogiAction) => {
    const taken = position.state.board[action.to.y][action.to.x];
    return (
      (taken?.side === root ? 10000 + pieceValue(taken) : taken ? pieceValue(taken) : 0) +
      (action.type === "movePiece" && action.promote ? 100 : 0)
    );
  };
  return [...actions].sort((a, b) => score(b) - score(a) || encodeAction(a) - encodeAction(b));
}

export async function runLethalGuard(
  position: AnalysisPosition,
  candidates: readonly AiCandidate[],
  shallowPool: readonly StudyCandidate[],
  options: LethalGuardOptions,
  context: { deadline?: number; signal?: AbortSignal } = {},
): Promise<LethalGuardReport> {
  const started = performance.now();
  const budgetMs = options.budgetMs ?? 250,
    horizon = options.horizon ?? 4;
  const selection = options.selection ?? "top3-reserve";
  if (
    !["off", "observe", "experimental"].includes(options.mode) ||
    !["top3", "top5", "top3-reserve", "all"].includes(selection) ||
    !Number.isFinite(budgetMs) ||
    budgetMs < 0 ||
    budgetMs > 5000 ||
    !Number.isSafeInteger(horizon) ||
    horizon < 1 ||
    horizon > 4
  )
    throw Error("ガード設定が不正です");
  const report: LethalGuardReport = {
    version: "finite-lethal-reply-guard-v1",
    mode: options.mode,
    stateHash: position.stateHash,
    horizon,
    selection,
    budgetMs,
    elapsedMs: 0,
    work: 0,
    transitions: 0,
    estimatedBytes: 0,
    parentRssBytes: process.memoryUsage().rss,
    originalCandidates: candidates,
    rows: [],
    originalAction: candidates[0]?.action ?? null,
    hypotheticalAction: candidates[0]?.action ?? null,
    changed: false,
    wouldChange: false,
    reason: "unchanged",
  };
  if (options.mode === "off") {
    report.reason = "off";
    return report;
  }
  if (
    candidates[0]?.evaluation?.evaluationKind === "terminal" &&
    position.state.turn &&
    candidates[0].evaluation.values[position.state.turn].primary === 1
  ) {
    report.reason = "sole_win_preserved";
    return report;
  }
  const root = position.state.turn;
  if (!root || !getActiveSides(position.state).includes(root) || !candidates.length) {
    report.reason = "no_candidate";
    return report;
  }
  const deadline = Math.min(started + budgetMs, context.deadline ?? Infinity);
  const legal = getAnalysisLegalActions(position),
    ids = new Set(legal.map(encodeAction));
  const top = candidates.slice(0, selection === "top5" ? 5 : 3);
  const reserve =
    selection === "top3-reserve" || selection === "all"
      ? [...shallowPool]
          .sort(
            (a, b) =>
              (b.study.initialScore ?? -Infinity) - (a.study.initialScore ?? -Infinity) ||
              a.rootIndex - b.rootIndex,
          )
          .slice(0, 2)
      : [];
  const ordered = [top[0], ...reserve, ...top.slice(1)].filter(
    (entry): entry is AiCandidate => !!entry,
  );
  const pool = new Map<number, GuardRow>();
  for (const candidate of ordered) {
    const actionId = encodeAction(candidate.action);
    if (!ids.has(actionId)) throw Error("ガード候補が正本上の合法手ではありません");
    if (pool.has(actionId)) continue;
    const index = candidates.findIndex((entry) => encodeAction(entry.action) === actionId);
    pool.set(actionId, {
      action: candidate.action,
      actionId,
      maxNRank: index < 0 ? null : index + 1,
      source: index < 0 ? "static-reserve" : "maxn",
      candidate,
      status: "unknown",
      completedWithinBudget: false,
      proof: null,
      witness: null,
    });
  }
  if (selection === "all")
    for (const action of legal) {
      const actionId = encodeAction(action);
      if (!pool.has(actionId))
        pool.set(actionId, {
          action,
          actionId,
          maxNRank: null,
          source: "diagnostic-only",
          candidate: null,
          status: "unknown",
          completedWithinBudget: false,
          proof: null,
          witness: null,
        });
    }
  report.rows = [...pool.values()];
  const maxTransitions = options.maxTransitions ?? 5000,
    maxWork = options.maxWork ?? 100000,
    maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  for (const row of report.rows) {
    if (
      context.signal?.aborted ||
      performance.now() >= deadline ||
      report.transitions >= maxTransitions ||
      report.work >= maxWork ||
      report.estimatedBytes >= maxBytes
    )
      break;
    const remaining = deadline - performance.now();
    const proof = await proveFiniteAction(position, row.action, root, horizon, {
      maxTransitions: Math.max(0, maxTransitions - report.transitions),
      maxWork: Math.max(0, maxWork - report.work),
      maxNodes: 4096,
      maxBytes: Math.max(0, maxBytes - report.estimatedBytes),
      maxMs: Math.max(0, Math.min(remaining, Math.max(10, budgetMs / 2))),
      signal: context.signal,
      order: (current, moves) => replyOrder(current, moves, root),
    });
    row.proof = proof;
    row.witness = finiteLossWitness(proof);
    row.completedWithinBudget =
      performance.now() <= deadline && !context.signal?.aborted && proof.status !== "unknown";
    row.status = row.completedWithinBudget ? proof.status : "unknown";
    report.work += proof.work ?? proof.transitions;
    report.transitions += proof.transitions;
    report.estimatedBytes += proof.estimatedBytes ?? 0;
    report.parentRssBytes = Math.max(report.parentRssBytes, process.memoryUsage().rss);
  }
  const chosen = chooseGuardCandidate(candidates, report.rows, root);
  report.hypotheticalAction = chosen?.action ?? report.originalAction;
  report.wouldChange =
    !!chosen && encodeAction(chosen.action) !== encodeAction(candidates[0].action);
  report.changed = options.mode === "experimental" && report.wouldChange;
  report.elapsedMs = performance.now() - started;
  report.reason = context.signal?.aborted
    ? "cancelled"
    : report.wouldChange
      ? "unsafe_incumbent_to_proven_safe"
      : "no_comparable_safe_alternative";
  return report;
}
