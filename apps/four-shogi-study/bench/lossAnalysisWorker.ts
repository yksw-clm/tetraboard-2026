import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  getAnalysisStateHash,
  restoreAnalysisPosition,
  type AnalysisPosition,
  type FourShogiReplayEvent,
} from "@tetraboard/four-shogi/analysis";
import { getActiveSides, type FourShogiAction } from "@tetraboard/four-shogi";
import { encodeAction, decodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import {
  createStudyRootSearch,
  compareStudyCandidates,
  explainStudyEvaluation,
  type StudyCandidate,
} from "../../../packages/four-shogi/src/studySearch";
import {
  studyTraceAction,
  type StudyTraceEvent,
  type StudySearchDiagnostics,
} from "../../../packages/four-shogi/src/studyDiagnostics";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { loadPlayer } from "../../../packages/four-shogi/bench/baseline";
import {
  createStudySearchRuntime,
  type StudySearchRuntime,
  type StudyRuntimeTraceEvent,
} from "../src/search/runtime";
import { parallelTrial } from "./parallelSearch";
import { DiagnosticLog, drainTask } from "./tacticsDiagnostics";
import {
  lossAnalysisLimits as limits,
  lossSourceIdentity,
  type LossCase,
} from "./lossAnalysisCases";
import { proveFiniteAction, validateFiniteProof } from "./lossSafety";

export type PolicyRow = {
  action: FourShogiAction;
  actionId: number;
  rootIndex: number | null;
  staticRank: number | null;
  staticEvaluation: ReturnType<typeof explainStudyEvaluation>["evaluation"];
  status: "returned" | "eliminated" | "terminal_alive" | "horizon" | "budget";
  steps: { event: FourShogiReplayEvent; beforeHash: string; afterHash: string }[];
  opponentWork: number;
  elapsedMs: number;
  recordedPrefixMatches: boolean | null;
};
export type LossWorkerJob = {
  mode: "policy" | "runtime" | "fixed" | "safety";
  caseFile: string;
  output: string;
  caseHash: string;
  sourceFingerprint: string;
  actionId?: number;
  actionIds?: number[];
  policyFile?: string;
};
let stopped = false,
  activeRuntime: StudySearchRuntime | null = null;
process.on("SIGTERM", () => {
  stopped = true;
  void activeRuntime?.close();
});
process.on("SIGINT", () => {
  stopped = true;
  void activeRuntime?.close();
});
function save(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value) + "\n");
  renameSync(path + ".tmp", path);
}

function rootSession(
  position: AnalysisPosition,
  record: LossCase,
  diagnostics?: StudySearchDiagnostics,
) {
  return createStudyRootSearch(
    position,
    { profile: "study", strategy: record.strategy, cacheSize: limits.memoryMb, maxDepth: 256 },
    diagnostics,
  );
}
function prepare(search: ReturnType<typeof createStudyRootSearch>) {
  return drainTask(search, performance.now() + limits.fixedMs, true, limits.fixedWork);
}
async function validatePv(position: AnalysisPosition, candidate: StudyCandidate) {
  let current = position;
  for (const [index, step] of candidate.line.entries()) {
    if (current.state.turn !== step.side || step.afterPly !== index + 1)
      throw Error("診断PVの手番が不正です");
    current = await advanceAnalysisPosition(current, {
      type: "action",
      side: step.side,
      action: step.action,
    });
    if (current.state.turn !== step.nextTurn) throw Error("診断PVの次手番が不正です");
  }
  return {
    legal: true,
    plies: candidate.line.length,
    leafHash: current.stateHash,
    leafExplanation: explainStudyEvaluation(current),
    lineEvaluationMatches: candidate.lineEvaluation
      ? hashJson(candidate.lineEvaluation) === hashJson(explainStudyEvaluation(current).evaluation)
      : null,
  };
}

async function policy(record: LossCase, position: AnalysisPosition, output: string) {
  const search = rootSession(position, record);
  let ready = false,
    roots: StudyCandidate[] = [];
  try {
    ready = prepare(search).complete;
    if (ready)
      roots = [...search.snapshot().candidates].sort((a, b) =>
        compareStudyCandidates(a, b, record.side),
      );
  } finally {
    search.dispose();
  }
  const opponent = await loadPlayer("frozen"),
    started = performance.now();
  const rows: PolicyRow[] = [];
  try {
    const chosen = encodeAction(record.chosenAction);
    const ordered = [...record.legalActions].sort(
      (a, b) => Number(encodeAction(b) === chosen) - Number(encodeAction(a) === chosen),
    );
    for (const action of ordered) {
      if (stopped || performance.now() - started >= limits.policyCaseMs) break;
      const before = performance.now();
      let current = position,
        work = 0;
      const steps: PolicyRow["steps"] = [];
      const apply = async (event: FourShogiReplayEvent) => {
        const previous = current;
        current = await advanceAnalysisPosition(current, event);
        steps.push({ event, beforeHash: previous.stateHash, afterHash: current.stateHash });
      };
      await apply({ type: "action", side: record.side, action });
      const staticEvaluation = explainStudyEvaluation(current).evaluation;
      while (
        !stopped &&
        current.state.status === "playing" &&
        getActiveSides(current.state).includes(record.side) &&
        current.state.turn !== record.side &&
        steps.length < limits.policyPlies &&
        performance.now() - before < limits.policyActionMs
      ) {
        const choice = opponent.selector(current.state);
        if (
          !choice.action ||
          !getAnalysisLegalActions(current).some(
            (legal) => encodeAction(legal) === encodeAction(choice.action!),
          )
        )
          throw Error("凍結Lv2の応手が非合法です");
        work += choice.stats?.work ?? 0;
        await apply({ type: "action", side: current.state.turn, action: choice.action });
      }
      const alive = getActiveSides(current.state).includes(record.side);
      const status = !alive
        ? "eliminated"
        : current.state.status === "finished"
          ? "terminal_alive"
          : current.state.turn === record.side
            ? "returned"
            : stopped || performance.now() - before >= limits.policyActionMs
              ? "budget"
              : "horizon";
      const root = roots.find(
        (candidate) => encodeAction(candidate.action) === encodeAction(action),
      );
      const row: PolicyRow = {
        action,
        actionId: encodeAction(action),
        rootIndex: root?.rootIndex ?? null,
        staticRank: root ? roots.indexOf(root) + 1 : null,
        staticEvaluation,
        status,
        steps,
        opponentWork: work,
        elapsedMs: performance.now() - before,
        recordedPrefixMatches:
          encodeAction(action) === chosen
            ? steps.every((step, index) => {
                const actual = record.actualSuffix[index];
                return (
                  actual &&
                  actual.event.type === "action" &&
                  step.event.type === "action" &&
                  actual.event.side === step.event.side &&
                  encodeAction(actual.event.action) === encodeAction(step.event.action) &&
                  actual.afterHash === step.afterHash
                );
              })
            : null,
      };
      rows.push(row);
      appendFileSync(output + ".progress.jsonl", JSON.stringify(row) + "\n");
    }
    return {
      mode: "policy",
      ready,
      complete: rows.length === record.legalActions.length,
      opponent: opponent.metadata,
      rows,
      unexamined: record.legalActions
        .map(encodeAction)
        .filter((id) => !rows.some((row) => row.actionId === id)),
      goal: "return-to-next-own-turn-against-frozen-Lv2-policy-only",
    };
  } finally {
    opponent.dispose();
  }
}

async function runtime(record: LossCase) {
  const trace: { iterations: unknown[]; assignments: unknown[]; truncated: boolean } = {
    iterations: [],
    assignments: [],
    truncated: false,
  };
  const observe = (event: StudyRuntimeTraceEvent) => {
    if (event.type === "iteration") trace.iterations.push(event);
    if (event.type === "command" && event.command.type === "task") {
      if (trace.assignments.length < 20000)
        trace.assignments.push({ worker: event.worker, ...event.command });
      else trace.truncated = true;
    }
  };
  const service = createStudySearchRuntime({
    threads: 4,
    memoryMb: 4096,
    reuseWorkers: false,
    taskPartition: "root",
    measureStages: true,
    observeDiagnostic: observe,
  });
  activeRuntime = service;
  try {
    const trial = await parallelTrial(
      service,
      { origin: { kind: "replay", replay: record.replay }, events: [] },
      { timeBudgetMs: 2000, profile: "study", strategy: record.strategy },
    );
    return {
      mode: "runtime",
      condition: "new-instrumented-replay-not-original-transcript",
      trace,
      responseMs: trial.responseMs,
      snapshot: trial.snapshot,
      completed: trial.snapshot.status === "completed",
    };
  } finally {
    await service.close();
    activeRuntime = null;
  }
}

async function fixed(
  record: LossCase,
  position: AnalysisPosition,
  actionId: number,
  policyRows: PolicyRow[],
  output: string,
) {
  const action = record.legalActions.find((move) => encodeAction(move) === actionId);
  if (!action) throw Error("固定根が合法手にありません");
  const actual = actionId === encodeAction(record.chosenAction);
  const policyRow = policyRows.find((row) => row.actionId === actionId);
  const watchEvents = actual
    ? record.actualSuffix.map((step) => step.event)
    : (policyRow?.steps.map((step) => step.event) ?? [
        { type: "action" as const, side: record.side, action },
      ]);
  const watch = watchEvents.map((event) => {
    if (event.type !== "action") throw Error("診断の監視はactionのみです");
    return studyTraceAction(event.side, decodeAction(encodeAction(event.action)));
  });
  const log = new DiagnosticLog<StudyTraceEvent>(limits.traceBytes);
  const search = rootSession(position, record, {
    watchPaths: [watch],
    observe: (event) => log.append(event),
  });
  const results: Record<string, unknown>[] = [];
  let index: number | null = null;
  try {
    const prepared = prepare(search);
    if (!prepared.complete)
      return {
        mode: "fixed",
        actionId,
        prepared,
        complete: false,
        results,
        trace: [],
        truncated: false,
      };
    index =
      search.snapshot().candidates.find((candidate) => encodeAction(candidate.action) === actionId)
        ?.rootIndex ?? null;
    if (index === null) throw Error("固定根と初期列挙番号が対応しません");
    for (const depth of record.depths) {
      if (stopped) break;
      search.startTask(index, depth, false, record.taskPolicy ?? undefined);
      const completion = drainTask(
        search,
        performance.now() + limits.fixedMs,
        false,
        limits.fixedWork,
      );
      const snapshot = search.snapshot();
      const candidate =
        completion.complete && snapshot.depth === depth ? snapshot.candidates[0] : null;
      results.push({
        depth,
        completion,
        candidate,
        stats: snapshot.stats,
        pv: candidate ? await validatePv(position, candidate) : null,
      });
      appendFileSync(output + ".progress.jsonl", JSON.stringify(results.at(-1)) + "\n");
      if (!candidate) break;
    }
  } finally {
    search.dispose();
  }
  const nodes = [];
  for (const event of log.entries) {
    if (event.type !== "selection") continue;
    const length = event.path.length;
    const expected = watchEvents[length];
    if (!expected || expected.type !== "action") continue;
    let prefix = position;
    for (const step of watchEvents.slice(0, length))
      prefix = await advanceAnalysisPosition(prefix, step);
    const hash = await getAnalysisStateHash(event.state);
    const row = event.rows.find(
      (item) => encodeAction(item.action) === encodeAction(expected.action),
    );
    const legal = getAnalysisLegalActions(prefix).some(
      (move) => encodeAction(move) === encodeAction(expected.action),
    );
    nodes.push({
      event,
      expectedAction: expected.action,
      expectedSide: expected.side,
      stateHash: hash,
      samePosition: hash === prefix.stateHash,
      legal,
      row: row ?? null,
    });
  }
  let observerControl: unknown = null,
    intervention: unknown = null;
  const first = results[0];
  if (actual && first?.candidate) {
    const baseline = rootSession(position, record);
    try {
      const prepared = prepare(baseline);
      if (prepared.complete) {
        baseline.startTask(index!, record.depths[0], false, record.taskPolicy ?? undefined);
        const completion = drainTask(
          baseline,
          performance.now() + limits.fixedMs,
          false,
          limits.fixedWork,
        );
        const candidate = completion.complete ? baseline.snapshot().candidates[0] : null;
        observerControl = {
          completion,
          matches: candidate ? hashJson(candidate) === hashJson(first.candidate) : null,
        };
      } else observerControl = { completion: prepared, matches: null };
    } finally {
      baseline.dispose();
    }
    const completedDepths = results
      .filter((row) => row.candidate)
      .map((row) => row.depth as number);
    const omitted = nodes
      .filter(
        (node) =>
          node.samePosition &&
          node.legal &&
          node.row &&
          !node.row.selected &&
          completedDepths.includes(node.event.taskDepth),
      )
      .sort(
        (a, b) =>
          b.event.taskDepth - a.event.taskDepth || a.event.path.length - b.event.path.length,
      )[0];
    if (omitted && !log.truncated && !stopped) {
      const included = new DiagnosticLog<StudyTraceEvent>(limits.traceBytes);
      const altered = rootSession(position, record, {
        watchPaths: [watch],
        observe: (event) => included.append(event),
        includeAt: {
          key: omitted.event.key,
          path: omitted.event.path,
          action: omitted.expectedAction,
        },
      });
      try {
        const prepared = prepare(altered);
        if (prepared.complete) {
          const steps = [];
          for (const depth of record.depths.filter((value) => value <= omitted.event.taskDepth)) {
            altered.startTask(index!, depth, false, record.taskPolicy ?? undefined);
            const completion = drainTask(
              altered,
              performance.now() + limits.fixedMs,
              false,
              limits.fixedWork,
            );
            const candidate = completion.complete ? altered.snapshot().candidates[0] : null;
            steps.push({
              depth,
              completion,
              candidate,
              pv: candidate ? await validatePv(position, candidate) : null,
            });
            if (!candidate) break;
          }
          intervention = {
            condition: "diagnostic-one-node-include-only-default-selector-unchanged",
            target: {
              path: omitted.event.path,
              key: omitted.event.key,
              action: omitted.expectedAction,
              depth: omitted.event.taskDepth,
            },
            applied: included.entries.some(
              (event) =>
                event.type === "selection" &&
                event.rows.some(
                  (row) =>
                    row.reason === "diagnostic_include" &&
                    encodeAction(row.action) === encodeAction(omitted.expectedAction),
                ),
            ),
            steps,
            truncated: included.truncated,
          };
        } else intervention = { prepared, applied: false };
      } finally {
        altered.dispose();
      }
    }
  }
  const after = await advanceAnalysisPosition(position, {
    type: "action",
    side: record.side,
    action,
  });
  return {
    mode: "fixed",
    actionId,
    index,
    taskPolicy: record.taskPolicy,
    depths: record.depths,
    results,
    trace: log.entries,
    traceNodes: nodes,
    truncated: log.truncated,
    omittedEvents: log.omitted,
    observerControl,
    intervention,
    afterChosenExplanation: explainStudyEvaluation(after),
  };
}

async function safety(
  record: LossCase,
  position: AnalysisPosition,
  actionIds: number[],
  policyRows: PolicyRow[],
  output: string,
) {
  const preferred: Record<string, number[]> = {};
  for (const step of [...record.actualSuffix, ...policyRows.flatMap((row) => row.steps)]) {
    if (step.event.type !== "action") continue;
    preferred[step.beforeHash] ??= [];
    const id = encodeAction(step.event.action);
    if (!preferred[step.beforeHash].includes(id)) preferred[step.beforeHash].push(id);
  }
  const started = performance.now(),
    rows = [];
  for (const horizon of limits.safetyHorizons) {
    for (const actionId of actionIds) {
      if (stopped || performance.now() - started > limits.safetyCaseMs)
        return { mode: "safety", complete: false, rows };
      const action = record.legalActions.find((move) => encodeAction(move) === actionId);
      if (!action) throw Error("有限検証の根が非合法です");
      const proof = await proveFiniteAction(position, action, record.side, horizon, {
        maxTransitions: limits.safetyTransitions,
        maxMs: limits.safetyQueryMs,
        preferred,
      });
      const validation = await validateFiniteProof(position, proof);
      const certificatePath = output + `.h${horizon}-a${actionId}.certificate.json`;
      save(certificatePath, { caseId: record.id, actionId, horizon, proof, validation });
      const row = {
        actionId,
        horizon,
        proof: {
          inputHash: proof.inputHash,
          status: proof.status,
          goal: proof.goal,
          opponentModel: proof.opponentModel,
          transitions: proof.transitions,
          elapsedMs: proof.elapsedMs,
        },
        validation,
        certificateFile: basename(certificatePath),
      };
      rows.push(row);
      appendFileSync(
        output + ".progress.jsonl",
        JSON.stringify({
          actionId,
          horizon,
          status: proof.status,
          validation,
          transitions: proof.transitions,
        }) + "\n",
      );
    }
  }
  return { mode: "safety", complete: true, rows };
}

export async function runLossWorker(job: LossWorkerJob) {
  if (hashJson(lossSourceIdentity()) !== job.sourceFingerprint)
    throw Error("診断コードが事前登録と一致しません");
  const record: LossCase = JSON.parse(readFileSync(job.caseFile, "utf8"));
  if (hashJson(record) !== job.caseHash) throw Error("診断入力のSHAが一致しません");
  const position = await restoreAnalysisPosition(record.replay);
  if (position.stateHash !== record.stateHash || position.state.turn !== record.side)
    throw Error("診断局面が一致しません");
  const policyRows: PolicyRow[] = job.policyFile
    ? JSON.parse(readFileSync(job.policyFile, "utf8")).result.rows
    : [];
  const started = performance.now();
  const result =
    job.mode === "policy"
      ? await policy(record, position, job.output)
      : job.mode === "runtime"
        ? await runtime(record)
        : job.mode === "fixed"
          ? await fixed(record, position, job.actionId!, policyRows, job.output)
          : await safety(record, position, job.actionIds!, policyRows, job.output);
  const value = {
    caseId: record.id,
    caseHash: job.caseHash,
    mode: job.mode,
    elapsedMs: performance.now() - started,
    stopped,
    result,
  };
  if (hashJson(lossSourceIdentity()) !== job.sourceFingerprint)
    throw Error("診断中にコードが変更されました");
  if (Buffer.byteLength(JSON.stringify(value)) > limits.caseBytes)
    save(job.output, {
      caseId: record.id,
      caseHash: job.caseHash,
      mode: job.mode,
      complete: false,
      reason: "output_limit",
      elapsedMs: performance.now() - started,
    });
  else save(job.output, value);
}
export type LossPolicyResult = Awaited<ReturnType<typeof policy>>;
export type LossRuntimeResult = Awaited<ReturnType<typeof runtime>>;
export type LossFixedResult = Awaited<ReturnType<typeof fixed>>;
export type LossSafetyResult = Awaited<ReturnType<typeof safety>>;
if (import.meta.main) await runLossWorker(JSON.parse(readFileSync(resolve(Bun.argv[2]), "utf8")));
