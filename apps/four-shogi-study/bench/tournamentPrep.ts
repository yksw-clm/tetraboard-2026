import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import type {
  StudySearchOptions,
  StudySearchRuntime,
  StudySearchSnapshot,
} from "../src/search/runtime";
import type { LethalGuardOptions } from "../src/search/lethalGuard";
import type { StudyLifecycleEvent } from "../src/search/deadline";
import type { StudyPositionInput } from "../src/shared/model";
import { restoreStudyPosition } from "../src/domain/study";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { studyTacticalCases, acceptsStudyTactic } from "./studyTactics";
import { tacticInput } from "./tacticsDiagnostics";
import { validateGuardCandidate, validateGuardReport } from "./lethalGuardValidation";
import { guardBenchIdentity } from "./lethalGuardBench";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import {
  proveFiniteAction,
  validateFiniteProof,
} from "../../../packages/four-shogi/src/finiteSurvival";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";

/** 期限でpauseを呼ばず、最終通知とgetの外側経過を別々に測ります。 */
export async function measureTournamentTrial(
  runtime: StudySearchRuntime,
  input: StudyPositionInput,
  options: StudySearchOptions,
) {
  const started = performance.now();
  let resolveDone!: (s: StudySearchSnapshot) => void;
  const done = new Promise<StudySearchSnapshot>((r) => {
    resolveDone = r;
  });
  let notifiedAt = 0,
    notifications = 0;
  const id = await runtime.start(input, options, (s) => {
    if (s.status !== "running") {
      notifications++;
      notifiedAt ||= performance.now();
      resolveDone(s);
    }
  });
  const startReturnedMs = performance.now() - started;
  let watchdog = false;
  const timer = setTimeout(
    () => {
      watchdog = true;
      void runtime.cancel(id);
    },
    (options.timeBudgetMs ?? 10000) + 2000,
  );
  try {
    const notified = await done;
    const getting = performance.now();
    const snapshot = runtime.get(id) ?? notified;
    return {
      snapshot,
      notificationMs: notifiedAt - started,
      getMs: performance.now() - getting,
      responseMs: performance.now() - started,
      startReturnedMs,
      notifications,
      watchdog,
    };
  } finally {
    clearTimeout(timer);
  }
}

type PrepJob = {
  id: string;
  inputFile?: string;
  tacticId?: string;
  input?: StudyPositionInput;
  strategy: "adaptive" | "dual-continuations";
  budgetMs: number;
  guard: LethalGuardOptions;
  warm?: boolean;
  repeat?: number;
  finiteDiagnostic?: boolean;
  legacyRuntime?: string;
  legacyTimer?: string;
};

export async function runTournamentSpec(file: string) {
  const spec = JSON.parse(readFileSync(file, "utf8"));
  const source = guardBenchIdentity();
  if (spec.source && hashJson(source) !== hashJson(spec.source))
    throw Error("測定ソースが一致しません");
  if (existsSync(spec.output)) throw Error("結果を上書きしません");
  const cases = studyTacticalCases();
  writeFileSync(spec.output, "");
  let count = 0;
  for (const job of spec.jobs as PrepJob[]) {
    const tactic = job.tacticId ? cases.find((c) => c.id === job.tacticId) : undefined;
    if (job.tacticId && !tactic) throw Error("戦術IDがありません: " + job.tacticId);
    const record = job.inputFile ? JSON.parse(readFileSync(job.inputFile, "utf8")) : null;
    const input: StudyPositionInput =
      job.input ??
      (tactic
        ? tacticInput(tactic.state)
        : { origin: { kind: "replay", replay: record.replay }, events: [] });
    const position = await restoreStudyPosition(input);
    if (record?.stateHash && position.stateHash !== record.stateHash) throw Error("入力hash不一致");
    const events: StudyLifecycleEvent[] = [],
      workers: unknown[] = [];
    const factory = job.legacyRuntime
      ? (await import(pathToFileURL(job.legacyRuntime).href)).createGuardedStudySearchRuntime
      : createGuardedStudySearchRuntime;
    const runtime: StudySearchRuntime = factory(
      {
        threads: 4,
        memoryMb: 4096,
        taskPartition: "root",
        reuseWorkers: !!job.warm,
        measureStages: true,
        observeLifecycle: (e: StudyLifecycleEvent) => {
          if (events.length < 10000) events.push(e);
        },
        observeParallel: (e: { type: string }) => {
          if (e.type === "worker" && workers.length < 256) workers.push(e);
        },
      },
      job.guard,
    );
    try {
      if (job.warm)
        await measureTournamentTrial(runtime, input, {
          strategy: job.strategy,
          timeBudgetMs: null,
          maxDepth: 1,
          broadDepth: 3,
        });
      events.length = 0;
      workers.length = 0;
      const startedAt = new Date().toISOString();
      const options = { strategy: job.strategy, timeBudgetMs: job.budgetMs, broadDepth: 3 };
      const result = job.legacyTimer
        ? await (
            await import(pathToFileURL(job.legacyTimer).href)
          ).timedNormal(runtime, input, options, job.budgetMs)
        : await measureTournamentTrial(runtime, input, options);
      const endedAt = new Date().toISOString();
      const snapshot: StudySearchSnapshot = result.snapshot;
      const valid = getAnalysisLegalActions(position).some(
        (a) =>
          encodeAction(a) ===
          (snapshot.recommendedAction ? encodeAction(snapshot.recommendedAction) : -1),
      );
      for (const candidate of snapshot.candidates)
        await validateGuardCandidate(position, candidate);
      const proofs = snapshot.lethalGuard
        ? await validateGuardReport(position, snapshot.lethalGuard)
        : null;
      const candidate = snapshot.candidates[0] as StudyCandidate | undefined;
      const completed =
        snapshot.status === "completed" && snapshot.completedDepth > 0 && !!candidate && valid;
      const guardFinalized =
        job.guard.mode === "off" ||
        (!!snapshot.lethalGuard &&
          !["timeout", "error"].includes(snapshot.completion?.guard ?? ""));
      const accepted = tactic
        ? completed &&
          result.responseMs <= job.budgetMs &&
          guardFinalized &&
          acceptsStudyTactic(tactic, snapshot)
        : null;
      let finite = null;
      if (job.finiteDiagnostic && candidate) {
        const proof = await proveFiniteAction(position, candidate.action, position.state.turn!, 4, {
          maxMs: 300,
          maxTransitions: 2500,
          maxWork: 100000,
          maxNodes: 4096,
          maxBytes: 16 * 1024 ** 2,
        });
        finite = {
          proof,
          validation: await validateFiniteProof(position, proof),
          scope: "extra diagnostic300ms, outside response/total-budget comparison",
        };
      }
      const closing = performance.now();
      await runtime.close();
      const closeMs = performance.now() - closing;
      const root = position.state.turn!;
      const scores = snapshot.candidates.slice(0, 2).map((c) => c.evaluation?.values[root]);
      const row = {
        job,
        source,
        startedAt,
        endedAt,
        inputHash: hashJson(input),
        stateHash: position.stateHash,
        restricted: position.state.threePlayerAttackProhibited,
        ...result,
        valid,
        completed,
        guardFinalized,
        accepted,
        withinBudget: result.responseMs <= job.budgetMs,
        proofs,
        finite,
        closeMs,
        events,
        workerDurations: workers,
        candidateMetrics: {
          scores,
          nextOwnTurns: Math.max(
            0,
            (candidate?.line.filter((s) => s.side === root).length ?? 0) - 1,
          ),
          danger: candidate?.danger ?? null,
          deepStarted:
            snapshot.timing?.deepStartedMs !== null && snapshot.timing?.deepStartedMs !== undefined,
        },
      };
      appendFileSync(spec.output, JSON.stringify(row) + "\n");
      count++;
      console.log(
        JSON.stringify({
          count,
          id: job.id,
          strategy: job.strategy,
          ms: job.budgetMs,
          status: snapshot.status,
          reason: snapshot.reason,
          depth: snapshot.completedDepth,
          responseMs: result.responseMs,
          valid,
          accepted,
          guard: snapshot.completion?.guard,
        }),
      );
    } finally {
      await runtime.close();
    }
  }
  if (hashJson(source) !== hashJson(guardBenchIdentity()))
    throw Error("測定中にソースが変化しました");
  writeFileSync(
    spec.output + ".complete.json",
    JSON.stringify({ source, count, endedAt: new Date().toISOString() }),
  );
}

if (import.meta.main) await runTournamentSpec(resolve(Bun.argv[2]));
