import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { createHash } from "node:crypto";
import {
  tacticalCases,
  acceptsTactic,
  tacticalFixtureVersion,
} from "../../../packages/four-shogi/bench/tactics";
import { git, sourceIdentity, repoRoot } from "../../../packages/four-shogi/bench/baseline";
import {
  createStudyRootSearch,
  compareStudyCandidates,
  explainStudyEvaluation,
  type StudyCandidate,
} from "../../../packages/four-shogi/src/studySearch";
import {
  studyTraceAction,
  type StudySearchDiagnostics,
  type StudyTraceEvent,
} from "../../../packages/four-shogi/src/studyDiagnostics";
import {
  getAnalysisLegalActions,
  advanceAnalysisPosition,
  type AnalysisPosition,
} from "../../../packages/four-shogi/src/analysis";
import {
  createStudySearchRuntime,
  type StudyRuntimeTraceEvent,
  type StudySearchSnapshot,
} from "../src/search/runtime";
import { restoreStudyPosition } from "../src/domain/study";
import type { StudyPositionInput } from "../src/shared/model";
import type { SearchMessage } from "../src/search/messages";
import type { FourShogiState, FourShogiAction } from "../../../packages/four-shogi/src/types";

export const diagnosticVersion = "study-tactics-diagnostics-v1";
export const actionKey = (action: FourShogiAction) => JSON.stringify(action);
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function tacticInput(state: FourShogiState): StudyPositionInput {
  return {
    origin: {
      kind: "setup",
      setup: {
        schemaVersion: 1,
        board: state.board.map((row) =>
          row.map((piece) =>
            piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
          ),
        ),
        hands: state.hands,
        turn: state.turn!,
        threePlayerAttackProhibited: state.threePlayerAttackProhibited,
        eliminations: state.eliminations.map((entry) => ({
          side: entry.side,
          rank: entry.rank!,
          group: entry.group,
        })),
      },
    },
    events: [],
  };
}

/** 記録の上限で探索を中断したり、既存イベントを捨てて成功に見せたりしません。 */
export class DiagnosticLog<T> {
  entries: T[] = [];
  bytes = 0;
  truncated = false;
  omitted = 0;
  constructor(readonly limit = 32 * 1024 * 1024) {}
  append(event: T) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.truncated || this.bytes + bytes > this.limit) {
      this.truncated = true;
      this.omitted++;
      return;
    }
    this.bytes += bytes;
    this.entries.push(structuredClone(event));
  }
}

type Session = ReturnType<typeof createStudyRootSearch>;
type Completion = {
  complete: boolean;
  reason: "complete" | "work_limit" | "time_limit";
  work: number;
};
export function drainTask(
  search: Session,
  deadline: number,
  preparation = false,
  maxWork = 2_000_000,
): Completion {
  const initialWork = search.work;
  if (performance.now() >= deadline) return { complete: false, reason: "time_limit", work: 0 };
  let ticks = 0;
  for (;;) {
    if (preparation && search.depth >= 1)
      return {
        complete: true,
        reason: "complete",
        work: search.work - initialWork,
      };
    if (search.work - initialWork >= maxWork)
      return { complete: false, reason: "work_limit", work: search.work - initialWork };
    if (search.step())
      return {
        complete: true,
        reason: "complete",
        work: search.work - initialWork,
      };
    if (++ticks % 128) continue;
    const work = search.work - initialWork;
    if (work >= maxWork) return { complete: false, reason: "work_limit", work };
    if (performance.now() >= deadline) return { complete: false, reason: "time_limit", work };
  }
}

/** 生きたruntimeが記録したworkerごとのタスク順序を、同じ探索本体へ再投入します。 */
export async function replayWorker(
  events: readonly StudyRuntimeTraceEvent[],
  worker: number,
  deadline: number,
  diagnostics?: StudySearchDiagnostics,
) {
  const commands = events.filter(
    (event): event is Extract<StudyRuntimeTraceEvent, { type: "command" }> =>
      event.type === "command" && event.worker === worker,
  );
  const start = commands.find((event) => event.command.type === "start")?.command;
  if (!start || start.type !== "start") throw new Error("workerの初期化記録がありません");
  const position = await restoreStudyPosition(start.input);
  const search = createStudyRootSearch(position, start.options, diagnostics);
  const results: {
    taskId: number;
    matches: boolean;
    candidate: StudyCandidate;
    expectedHash: string;
    extendedNodes: number;
  }[] = [];
  try {
    const prep = drainTask(search, Math.min(deadline, performance.now() + 30_000), true);
    if (!prep.complete) return { results, complete: false, reason: prep.reason };
    for (const event of commands) {
      const command = event.command;
      if (command.type !== "task") continue;
      const response = events.find(
        (entry): entry is Extract<StudyRuntimeTraceEvent, { type: "message" }> =>
          entry.type === "message" &&
          entry.worker === worker &&
          entry.message.type === "progress" &&
          entry.message.barrier &&
          entry.message.taskId === command.taskId,
      )?.message;
      // 最後の未完了タスクは、完成結果として再生・比較しません。
      if (!response || response.type !== "progress") break;
      const beforeExtended = search.snapshot().stats.extendedNodes;
      search.startTask(command.index, command.depth, command.material, command.policy);
      const completion = drainTask(search, Math.min(deadline, performance.now() + 30_000));
      if (!completion.complete) return { results, complete: false, reason: completion.reason };
      const candidate = search.snapshot().candidates[0];
      const expected = response.snapshot.candidates[0];
      results.push({
        taskId: command.taskId,
        matches: digest(candidate) === digest(expected),
        candidate,
        expectedHash: digest(expected),
        extendedNodes: search.snapshot().stats.extendedNodes - beforeExtended,
      });
      if (performance.now() >= deadline) return { results, complete: false, reason: "time_limit" };
    }
    return { results, complete: true, reason: "complete" };
  } finally {
    search.dispose();
  }
}

export async function explainLine(position: AnalysisPosition, candidate: StudyCandidate) {
  let current = position;
  const states = [];
  for (const step of candidate.line) {
    if (current.state.turn !== step.side) throw new Error("PVの実手番が不一致です");
    current = await advanceAnalysisPosition(current, {
      type: "action",
      side: step.side,
      action: step.action,
    });
    states.push({
      stateHash: current.stateHash,
      turn: current.state.turn,
      captured: step.captured,
      eliminations: current.state.eliminations,
    });
  }
  const explained = explainStudyEvaluation(current);
  return {
    states,
    finalStateHash: current.stateHash,
    finalPosition: current,
    explained,
    evaluationMatches: digest(explained.evaluation) === digest(candidate.evaluation),
  };
}

async function timed(
  input: StudyPositionInput,
  strategy: "adaptive" | "dual",
  events?: DiagnosticLog<StudyRuntimeTraceEvent>,
) {
  const runtime = createStudySearchRuntime({
    threads: 4,
    memoryMb: 8192,
    ...(events
      ? { observeDiagnostic: (event: StudyRuntimeTraceEvent) => events.append(event) }
      : {}),
  });
  try {
    let finish!: (value: StudySearchSnapshot) => void;
    const done = new Promise<StudySearchSnapshot>((resolve) => {
      finish = resolve;
    });
    await runtime.start(input, { strategy, profile: "study", timeBudgetMs: 1000 }, (value) => {
      if (value.status === "completed" || value.status === "error") finish(value);
    });
    const value = await done;
    if (value.status === "error") throw new Error(value.reason ?? "runtime error");
    return value;
  } finally {
    await runtime.close();
  }
}

function codeIdentity() {
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    engine: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")),
    runtime: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/src/search")),
    runner: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/bench")),
    fixtures: sourceIdentity(resolve(repoRoot, "packages/four-shogi/bench")),
  };
}
async function save(path: string, value: unknown) {
  await writeFile(path + ".tmp", JSON.stringify(value) + "\n");
  await rename(path + ".tmp", path);
}

type Historical = {
  id: string;
  strategy: string;
  accepted: boolean;
  action: FourShogiAction;
  candidates?: StudyCandidate[];
  completedDepth: number;
};
type FixedResult = {
  strategy: string;
  depth: number;
  rootIndex: number;
  action: FourShogiAction;
  policy: unknown;
  completion: Completion;
  candidate: StudyCandidate | null;
};

async function fixedDepths(
  position: AnalysisPosition,
  actions: readonly FourShogiAction[],
  deadline: number,
) {
  const legal = getAnalysisLegalActions(position);
  const results: FixedResult[] = [];
  for (const strategy of ["dual", "adaptive"] as const) {
    const search = createStudyRootSearch(position, {
      strategy,
      maxDepth: 9,
      extensions: 2,
      cacheSize: 8192,
    });
    try {
      if (!drainTask(search, Math.min(deadline, performance.now() + 30_000), true).complete) break;
      for (let depth = 2; depth <= 9; depth++)
        for (const action of actions) {
          if (performance.now() >= deadline) return results;
          const index = legal.findIndex((a) => actionKey(a) === actionKey(action));
          if (index < 0) throw new Error("比較初手が合法手にありません");
          const policy =
            strategy === "dual"
              ? {
                  phase: depth === 2 ? ("broad" as const) : ("deep" as const),
                  width: depth === 2 ? 6 : 2,
                  ownWidth: 3,
                }
              : undefined;
          search.startTask(index, depth, false, policy);
          const completion = drainTask(search, Math.min(deadline, performance.now() + 30_000));
          results.push({
            strategy,
            depth,
            rootIndex: index,
            action,
            policy,
            completion,
            candidate: completion.complete ? search.snapshot().candidates[0] : null,
          });
          if (!completion.complete) return results;
        }
    } finally {
      search.dispose();
    }
  }
  return results;
}

async function traceReplay(
  events: readonly StudyRuntimeTraceEvent[],
  paths: readonly (readonly string[])[],
  deadline: number,
  limit: number,
  includeAt?: StudySearchDiagnostics["includeAt"],
  disableBranchCache = false,
) {
  const log = new DiagnosticLog<StudyTraceEvent>(limit);
  const keys: Record<string, string> = {};
  const workers = [
    ...new Set(
      events
        .filter((e) => e.type === "command")
        .map((e) => (e as Extract<StudyRuntimeTraceEvent, { type: "command" }>).worker),
    ),
  ];
  const replays = [];
  for (const worker of workers) {
    if (performance.now() >= deadline) break;
    replays.push({
      worker,
      ...(await replayWorker(events, worker, deadline, {
        observe: (event) => {
          if (
            includeAt &&
            (event.key !== includeAt.key ||
              JSON.stringify(event.path) !== JSON.stringify(includeAt.path))
          )
            return;
          const key = digest(event.key);
          if (!log.truncated) keys[key] = event.key;
          log.append({ ...event, key });
        },
        watchPaths: paths,
        disableBranchCache,
        ...(includeAt ? { includeAt } : {}),
      })),
    });
  }
  return { log, replays, keys };
}

export function comparePublication(
  events: readonly StudyRuntimeTraceEvent[],
  replays: readonly ({ worker: number } & Awaited<ReturnType<typeof replayWorker>>)[],
  root: NonNullable<FourShogiState["turn"]>,
) {
  const publication = events.findLastIndex((e) => e.type === "publication" && e.published);
  const published = events[publication];
  if (!published || published.type !== "publication" || published.depth < 2)
    return { comparable: false, reason: "no_completed_cohort" };
  const before = [...published.candidates].sort((a, b) => compareStudyCandidates(a, b, root));
  const after: StudyCandidate[] = [];
  for (const candidate of before) {
    const message = events
      .slice(0, publication)
      .findLast(
        (e): e is Extract<StudyRuntimeTraceEvent, { type: "message" }> =>
          e.type === "message" &&
          e.message.type === "progress" &&
          e.message.barrier &&
          e.message.snapshot.depth === published.depth &&
          e.message.snapshot.candidates.some((c) => c.rootIndex === candidate.rootIndex),
      );
    if (!message || message.message.type !== "progress")
      return { comparable: false, reason: "missing_task" };
    const task = replays
      .find((r) => r.worker === message.worker)
      ?.results.find(
        (t) =>
          t.taskId === (message.message as Extract<SearchMessage, { type: "progress" }>).taskId,
      );
    if (!task) return { comparable: false, reason: "incomplete_replay" };
    after.push(task.candidate);
  }
  after.sort((a, b) => compareStudyCandidates(a, b, root));
  return {
    comparable: true,
    depth: published.depth,
    before,
    after,
    selectedBefore: before[0].action,
    selectedAfter: after[0].action,
    changed: actionKey(before[0].action) !== actionKey(after[0].action),
  };
}

export async function runDiagnostics(options: {
  outputDir: string;
  maxMinutes?: number;
  caseId?: string;
  repeats?: number;
}) {
  const maxMinutes = options.maxMinutes ?? 50;
  if (!(maxMinutes > 0 && maxMinutes <= 60)) throw new Error("実計測の上限は60分です");
  const repeats = options.repeats ?? 3;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error("反復は1〜3回です");
  await mkdir(options.outputDir, { recursive: false });
  const source = codeIdentity(),
    fingerprint = digest(source);
  const deadline = performance.now() + maxMinutes * 60_000;
  const original = JSON.parse(
    await readFile(resolve(repoRoot, "docs/four-shogi-study-search-results.json"), "utf8"),
  );
  const historical = original.tactics.results as Historical[];
  const cases = tacticalCases().filter(
    (t) =>
      ["poisoned-gold", "inactive-rook"].includes(t.family) &&
      (!options.caseId || t.id === options.caseId),
  );
  if (!cases.length) throw new Error("対象展開がありません");
  const manifest = {
    schemaVersion: 1,
    diagnosticVersion,
    startedAt: new Date().toISOString(),
    source,
    fixtureVersion: tacticalFixtureVersion,
    baselineCommit: "c07bf5ac3ba110bfb171f397ca25024ccca14d3d",
    historicalReportSha256: createHash("sha256")
      .update(await readFile(resolve(repoRoot, "docs/four-shogi-study-search-results.json")))
      .digest("hex"),
    environment: {
      bun: Bun.version,
      os: release(),
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      memoryBytes: totalmem(),
    },
    settings: {
      maxMinutes,
      repeats,
      timeBudgetMs: 1000,
      threads: 4,
      memoryMb: 8192,
      perFailureMs: 180_000,
      perControlMs: 60_000,
      perTaskMs: 30_000,
      maxWork: 2_000_000,
      maxLogBytes: 32 * 1024 * 1024,
    },
    caseIds: cases.map((t) => t.id),
  };
  await save(resolve(options.outputDir, "manifest.json"), manifest);
  const summaries: unknown[] = [];
  for (const tactic of cases) {
    if (performance.now() >= deadline) break;
    if (digest(codeIdentity()) !== fingerprint)
      throw new Error("測定中にコード・HEAD・作業ツリー状態が変わりました");
    const input = tacticInput(tactic.state),
      position = await restoreStudyPosition(input);
    const old = historical.find((r) => r.strategy === "dual" && r.id === tactic.id)!;
    const caseDeadline = Math.min(deadline, performance.now() + (old.accepted ? 60_000 : 180_000));
    const expected = getAnalysisLegalActions(position).filter((action) =>
      acceptsTactic(tactic, action),
    );
    const actions = [...new Map([old.action, ...expected].map((a) => [actionKey(a), a])).values()];
    const runs = [];
    for (const strategy of ["adaptive", "dual"] as const)
      for (let repeat = 0; repeat < repeats; repeat++) {
        if (caseDeadline - performance.now() < 1100) break;
        const result = await timed(input, strategy);
        runs.push({
          strategy,
          repeat,
          accepted: acceptsTactic(tactic, result.recommendedAction),
          result,
        });
      }
    const runtimeLog = new DiagnosticLog<StudyRuntimeTraceEvent>(8 * 1024 * 1024);
    const observed =
      caseDeadline - performance.now() >= 1100 ? await timed(input, "dual", runtimeLog) : null;
    const candidates = [
      ...(old.candidates ?? []),
      ...((observed?.candidates as StudyCandidate[]) ?? []),
    ];
    const unique = [
      ...new Map(candidates.map((c) => [digest({ action: c.action, line: c.line }), c])).values(),
    ];
    const lines = [];
    for (const c of unique) {
      const explained = await explainLine(position, c);
      lines.push({
        action: c.action,
        depth: c.completedDepth,
        expected: acceptsTactic(tactic, c.action),
        ...explained,
        finalPosition: undefined,
      });
    }
    const paths = unique.map((c) => c.line.map((step) => studyTraceAction(step.side, step.action)));
    const replay = await traceReplay(
      runtimeLog.entries,
      paths,
      Math.min(caseDeadline, performance.now() + 35_000),
      8 * 1024 * 1024,
    );
    const fixed = await fixedDepths(
      position,
      actions,
      Math.min(caseDeadline, performance.now() + 45_000),
    );
    const interventions = [];
    // 観測したPV上の成り・捕獲を優先し、同順位では浅い節点・合法手番号順に一手ずつ追加します。
    const nodes = [
      ...new Map(
        replay.log.entries
          .filter(
            (e): e is Extract<StudyTraceEvent, { type: "selection" }> =>
              e.type === "selection" &&
              e.taskDepth === observed?.completedDepth &&
              e.policy?.phase === "deep" &&
              e.policy.width === observed?.coverage?.opponentWidth &&
              e.policy.ownWidth === observed?.coverage?.ownWidth,
          )
          .map((e) => [digest({ key: e.key, path: e.path }), e]),
      ).values(),
    ].sort((a, b) => a.ply - b.ply || a.rootIndex - b.rootIndex);
    const probes = nodes.flatMap((node) =>
      node.rows.filter((row) => !row.selected).map((row) => ({ node, row })),
    );
    const tactical = (
      node: Extract<StudyTraceEvent, { type: "selection" }>,
      action: FourShogiAction,
    ) =>
      action.type === "movePiece" &&
      (action.promote || node.state.board[action.to.y][action.to.x] !== null);
    probes.sort(
      (a, b) =>
        Number(tactical(b.node, b.row.action)) - Number(tactical(a.node, a.row.action)) ||
        a.node.ply - b.node.ply ||
        a.node.rootIndex - b.node.rootIndex ||
        a.row.index - b.row.index,
    );
    for (const { node, row } of probes.slice(0, 12)) {
      if (performance.now() >= caseDeadline || interventions.length >= 12) break;
      const includeAt = { key: replay.keys[node.key], path: node.path, action: row.action };
      const result = await traceReplay(
        runtimeLog.entries,
        [node.path],
        Math.min(caseDeadline, performance.now() + 5_000),
        1024 * 1024,
        includeAt,
      );
      interventions.push({
        includeAt,
        witness:
          result.log.entries.find(
            (e) =>
              e.type === "selection" &&
              e.key === digest(includeAt.key) &&
              e.rows.some((row) => row.reason === "diagnostic_include"),
          ) ?? null,
        originalStaticRank: row.staticRank,
        reason: row.reason,
        replays: result.replays,
        applied: result.log.entries.some(
          (e) =>
            e.type === "selection" &&
            e.key === digest(includeAt.key) &&
            e.rows.some((row) => row.reason === "diagnostic_include"),
        ),
        comparison:
          !runtimeLog.truncated &&
          replay.replays.length === 4 &&
          replay.replays.every((r) => r.complete && r.results.every((t) => t.matches))
            ? comparePublication(runtimeLog.entries, result.replays, position.state.turn!)
            : { comparable: false, reason: "baseline_replay_incomplete" },
      });
    }
    let cacheControl = null;
    if (
      replay.log.entries.some((event) => event.type === "return" && event.reason === "cache") &&
      performance.now() < caseDeadline
    ) {
      const result = await traceReplay(
        runtimeLog.entries,
        [],
        Math.min(caseDeadline, performance.now() + 5000),
        1,
        undefined,
        true,
      );
      cacheControl = {
        mode: "completed_branch_cache_disabled",
        replays: result.replays,
        comparison:
          !runtimeLog.truncated &&
          replay.replays.length === 4 &&
          replay.replays.every((r) => r.complete && r.results.every((t) => t.matches))
            ? comparePublication(runtimeLog.entries, result.replays, position.state.turn!)
            : { comparable: false, reason: "baseline_replay_incomplete" },
      };
    }
    const detail = {
      schemaVersion: 1,
      id: tactic.id,
      family: tactic.family,
      proof: tactic.proof,
      criterion: tactic.criterion,
      stateHash: position.stateHash,
      input,
      original: {
        adaptive: historical.find((r) => r.id === tactic.id && r.strategy === "adaptive"),
        dual: old,
      },
      expected,
      actions,
      runs,
      observed,
      runtimeTrace: runtimeLog,
      coreTrace: replay.log,
      coreKeys: replay.keys,
      replayResults: replay.replays,
      lines,
      fixedMode: {
        mode: "fresh_single_lane_depth_sweep",
        depths: [2, 3, 4, 5, 6, 7, 8, 9],
        cacheSize: 8192,
        extensions: 2,
        actionOrder: actions,
      },
      fixed,
      interventions,
      cacheControl,
      sourceUnchanged: digest(codeIdentity()) === fingerprint,
      caseBudgetReached: performance.now() >= caseDeadline,
    };
    let detailBytes = Buffer.byteLength(JSON.stringify(detail));
    while (
      detailBytes > 32 * 1024 * 1024 &&
      (detail.coreTrace.entries.length || detail.runtimeTrace.entries.length)
    ) {
      const log = detail.coreTrace.entries.length ? detail.coreTrace : detail.runtimeTrace;
      const removed = log.entries.splice(-Math.min(100, log.entries.length));
      log.omitted += removed.length;
      log.truncated = true;
      detailBytes = Buffer.byteLength(JSON.stringify(detail));
    }
    if (detailBytes > 32 * 1024 * 1024) throw new Error("一展開の記録が32MiB上限を超えました");
    await save(resolve(options.outputDir, tactic.id + ".json"), detail);
    const summary = {
      id: tactic.id,
      originalAccepted: old.accepted,
      expectedCount: expected.length,
      runs: runs.map((r) => ({
        strategy: r.strategy,
        accepted: r.accepted,
        depth: r.result.completedDepth,
        action: r.result.recommendedAction,
      })),
      replayComplete:
        !runtimeLog.truncated &&
        replay.replays.length === 4 &&
        replay.replays.every((r) => r.complete),
      replayMatches: replay.replays.every((r) => r.results.every((t) => t.matches)),
      fixedComparisons: fixed.length,
      interventions: interventions.length,
      logsTruncated: runtimeLog.truncated || replay.log.truncated,
      sourceUnchanged: detail.sourceUnchanged,
    };
    summaries.push(summary);
    await save(resolve(options.outputDir, "status.json"), {
      complete: false,
      completed: summaries.length,
      planned: cases.length,
      summaries,
    });
    console.log(JSON.stringify(summary));
    if (!detail.sourceUnchanged) throw new Error("測定中のソース変更");
  }
  const result = {
    complete: summaries.length === cases.length,
    completed: summaries.length,
    planned: cases.length,
    summaries,
    sourceUnchanged: digest(codeIdentity()) === fingerprint,
    finishedAt: new Date().toISOString(),
  };
  await save(resolve(options.outputDir, "status.json"), result);
  return result;
}

/** 通常探索を変えず、記録済みの同じ通常深さで延長経路だけを有効にします。 */
export async function runDeepLeafComparison(sourceDir: string, output: string, maxMinutes = 5) {
  if (!(maxMinutes > 0 && maxMinutes <= 5)) throw new Error("追加の延長比較は5分以内です");
  if (await Bun.file(output).exists()) throw new Error("既存の比較結果を上書きできません");
  const manifest = JSON.parse(await readFile(resolve(sourceDir, "manifest.json"), "utf8"));
  const status = JSON.parse(await readFile(resolve(sourceDir, "status.json"), "utf8"));
  if (!status.complete || !status.sourceUnchanged)
    throw new Error("不完全な元調査を比較元にできません");
  const source = codeIdentity();
  const fingerprint = digest(source);
  const deadline = performance.now() + maxMinutes * 60000;
  const report = {
    schemaVersion: 1,
    kind: "same-normal-depth-deep-leaf-extension" as const,
    source,
    sourceManifestHash: createHash("sha256")
      .update(await readFile(resolve(sourceDir, "manifest.json")))
      .digest("hex"),
    sourceCommit: manifest.source.commit,
    maxMinutes,
    perCaseMs: 30000,
    cases: [] as unknown[],
    complete: false,
    sourceUnchanged: true,
  };
  for (const id of status.summaries
    .map((entry: { id: string }) => entry.id)
    .filter((id: string) => id.startsWith("poisoned-gold"))) {
    if (performance.now() >= deadline) break;
    const d = JSON.parse(await readFile(resolve(sourceDir, id + ".json"), "utf8"));
    const events = d.runtimeTrace.entries as StudyRuntimeTraceEvent[];
    const end = Math.min(deadline, performance.now() + 30000);
    const base = [];
    const changed = [];
    for (let worker = 0; worker < 4; worker++) {
      if (performance.now() >= end) break;
      base.push({ worker, ...(await replayWorker(events, worker, end)) });
    }
    const baseMatches =
      base.length === 4 && base.every((r) => r.complete && r.results.every((task) => task.matches));
    if (baseMatches)
      for (let worker = 0; worker < 4; worker++) {
        if (performance.now() >= end) break;
        changed.push({
          worker,
          ...(await replayWorker(events, worker, end, { extendDeepLeaves: true })),
        });
      }
    const comparison = baseMatches
      ? comparePublication(events, changed, d.input.origin.setup.turn)
      : { comparable: false, reason: "baseline_replay_incomplete" };
    report.cases.push({
      id,
      originalDepth: d.observed.completedDepth,
      baseMatches,
      base,
      changed,
      comparison,
      caseBudgetReached: performance.now() >= end,
    });
    report.sourceUnchanged = digest(codeIdentity()) === fingerprint;
    if (!report.sourceUnchanged) throw new Error("延長比較中のコード変更");
    await save(output, report);
    console.log(
      JSON.stringify({
        id,
        baseMatches,
        comparable: comparison.comparable,
        changed: "changed" in comparison ? comparison.changed : null,
      }),
    );
  }
  report.complete = report.cases.length === 8;
  await save(output, report);
  return report;
}

if (import.meta.main) {
  const args = new Map(
    Bun.argv.slice(2).map((arg) => {
      const match = /^--([a-z-]+)=(.+)$/.exec(arg);
      if (!match) throw new Error("引数は--name=valueです");
      return [match[1], match[2]];
    }),
  );
  for (const name of args.keys())
    if (
      !["output-dir", "max-minutes", "case", "repeats", "leaf-extensions-from", "output"].includes(
        name,
      )
    )
      throw new Error(`不明な引数: ${name}`);
  if (args.has("leaf-extensions-from")) {
    const output = args.get("output");
    if (!output) throw new Error("--outputが必要です");
    await runDeepLeafComparison(
      args.get("leaf-extensions-from")!,
      output,
      Number(args.get("max-minutes") ?? 5),
    );
  } else {
    const outputDir = args.get("output-dir");
    if (!outputDir) throw new Error("--output-dirが必要です");
    await runDiagnostics({
      outputDir,
      maxMinutes: Number(args.get("max-minutes") ?? 50),
      ...(args.has("case") ? { caseId: args.get("case") } : {}),
      repeats: Number(args.get("repeats") ?? 3),
    });
  }
}
