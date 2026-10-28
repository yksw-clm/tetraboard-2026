import {
  getActiveSides,
  getCheckState,
  sides,
  type GameResult,
  type Side,
} from "@tetraboard/four-shogi";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import {
  analyzePosition,
  type AiControl,
  type AiLineStep,
  type AiStopReason,
} from "@tetraboard/four-shogi/ai";

export const focusProjectionVersion = "local-focus-projection-v1";

export type FocusProjectionOptions = Readonly<{
  maxPlies?: number;
  workPerPly?: number;
  timeBudgetMs?: number | null;
}>;
export type FocusProjectionControl = Pick<
  AiControl,
  "signal" | "isCancelled" | "now" | "yieldToHost"
>;
export type FocusProjection = Readonly<{
  status: "ready" | "focus_eliminated" | "terminal" | "unreached" | "cancelled";
  reason: "ply_limit" | "deadline" | "no_legal_actions" | "cancelled" | null;
  sourceStateHash: string;
  analysisStateHash: string | null;
  position: AnalysisPosition | null;
  prefix: readonly AiLineStep[];
  result: GameResult | null;
  elapsedMs: number;
  model: Readonly<{
    version: typeof focusProjectionVersion;
    opponentModelId: "selfish-maxn-v1";
    workPerPly: number;
    maxPlies: number;
    work: number;
    decisions: readonly Readonly<{
      side: Side;
      work: number;
      completedDepth: number;
      fallback: boolean;
      stopReason: AiStopReason;
    }>[];
  }>;
}>;

/** 他席の合法な予測着手を進め、指定席の最初の実手番だけを解析対象にします。 */
export async function projectFocusPosition(
  position: AnalysisPosition,
  focusSide: Side,
  options: FocusProjectionOptions = {},
  control: FocusProjectionControl = {},
): Promise<FocusProjection> {
  getAnalysisLegalActions(position);
  if (!sides.includes(focusSide) || position.state.mode !== "singles")
    throw new TypeError("シングルスのフォーカス方向が必要です");
  const maxPlies = options.maxPlies ?? 12;
  const workPerPly = options.workPerPly ?? 256;
  const timeBudgetMs = options.timeBudgetMs === undefined ? 250 : options.timeBudgetMs;
  if (
    !Number.isSafeInteger(maxPlies) ||
    maxPlies < 0 ||
    maxPlies > 64 ||
    !Number.isSafeInteger(workPerPly) ||
    workPerPly < 1 ||
    workPerPly > 4096 ||
    (timeBudgetMs !== null && (!Number.isFinite(timeBudgetMs) || timeBudgetMs < 0))
  )
    throw new TypeError("予測は0〜64手、各手1〜4096work、非負の有限ミリ秒か無制限で指定します");
  let lastTime = -Infinity;
  const readTime = control.now ?? (() => performance.now());
  const now = () => {
    const value = readTime();
    if (!Number.isFinite(value) || value < lastTime)
      throw new TypeError("時計は単調な有限ミリ秒を返してください");
    lastTime = value;
    return value;
  };
  const started = now();
  const cancelled = () => control.signal?.aborted || control.isCancelled?.();
  const yieldToHost =
    control.yieldToHost ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const prefix: AiLineStep[] = [];
  const decisions: FocusProjection["model"]["decisions"][number][] = [];
  let current = position;
  let work = 0;
  function finish(
    status: FocusProjection["status"],
    reason: FocusProjection["reason"] = null,
  ): FocusProjection {
    return {
      status,
      reason,
      sourceStateHash: position.stateHash,
      analysisStateHash: status === "ready" ? current.stateHash : null,
      position: status === "ready" ? current : null,
      prefix,
      result: current.state.result,
      elapsedMs: now() - started,
      model: {
        version: focusProjectionVersion,
        opponentModelId: "selfish-maxn-v1",
        workPerPly,
        maxPlies,
        work,
        decisions,
      },
    };
  }
  while (true) {
    if (cancelled()) return finish("cancelled", "cancelled");
    if (!getActiveSides(current.state).includes(focusSide)) return finish("focus_eliminated");
    if (current.state.status === "finished") return finish("terminal");
    if (current.state.turn === focusSide) return finish("ready");
    if (prefix.length >= maxPlies) return finish("unreached", "ply_limit");
    const remainingMs =
      timeBudgetMs === null ? null : Math.max(0, timeBudgetMs - (now() - started));
    if (remainingMs === 0) return finish("unreached", "deadline");
    const side = current.state.turn;
    // 各相手は本人の単独効用を選びます。予測用の小予算と本検討の予算を分けます。
    const prediction = await analyzePosition(
      current,
      {
        codeVersion: focusProjectionVersion,
        algorithm: "maxn",
        maxWork: workPerPly,
        maxDepth: 2,
        rootWidth: 8,
        width: 4,
        extensions: 0,
        candidateCount: 2,
        dangerWork: 0,
        timeBudgetMs: remainingMs,
      },
      { ...control, now },
    );
    work += prediction.diagnostics.work;
    decisions.push({
      side,
      work: prediction.diagnostics.work,
      completedDepth: prediction.diagnostics.completedDepth,
      fallback: prediction.diagnostics.fallbackReason !== null,
      stopReason: prediction.diagnostics.stopReason,
    });
    if (cancelled() || prediction.status === "cancelled") return finish("cancelled", "cancelled");
    if (timeBudgetMs !== null && now() - started >= timeBudgetMs)
      return finish("unreached", "deadline");
    const action = prediction.recommendedAction;
    if (!action) return finish("unreached", "no_legal_actions");
    const next = await advanceAnalysisPosition(current, { type: "action", side, action });
    const checks = getCheckState(next.state);
    prefix.push({
      side,
      action,
      afterPly: prefix.length + 1,
      nextTurn: next.state.turn,
      checkedSides: getActiveSides(next.state).filter((target) => checks[target]),
      captured: next.state.lastMove!.captured,
      eliminations: next.state.eliminations.slice(current.state.eliminations.length),
      result: next.state.result,
    });
    current = next;
    await yieldToHost();
  }
}
