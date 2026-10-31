import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { git, repoRoot } from "../../../packages/four-shogi/bench/baseline";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import type { StudyCandidate } from "../../../packages/four-shogi/src/studySearch";
import {
  extractLossCases,
  lossAnalysisLimits as limits,
  lossSourceIdentity,
  type LossCase,
} from "./lossAnalysisCases";
import type {
  LossWorkerJob,
  LossPolicyResult,
  LossRuntimeResult,
  LossFixedResult,
  LossSafetyResult,
  PolicyRow,
} from "./lossAnalysisWorker";

function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}
function save(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}
function output<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return read<{ result?: T }>(path).result ?? null;
}
function diskBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce(
    (sum, entry) =>
      sum +
      (entry.isDirectory()
        ? diskBytes(join(path, entry.name))
        : statSync(join(path, entry.name)).size),
    0,
  );
}
export function selectMajorLossActions(
  record: LossCase,
  rows: readonly PolicyRow[],
  runtime: LossRuntimeResult | null,
) {
  const selected = new Set<number>();
  const depth = runtime?.snapshot.completedDepth;
  for (const iteration of runtime?.trace.iterations ?? []) {
    const item = iteration as { depth: number; roots: number[] };
    if (item.depth === depth) for (const index of item.roots) selected.add(index);
  }
  const ordered = [...rows].sort(
    (a, b) => (a.staticRank ?? Infinity) - (b.staticRank ?? Infinity) || a.actionId - b.actionId,
  );
  const returned = ordered.filter(
    (row) => row.status === "returned" || row.status === "terminal_alive",
  );
  const ids = [
    encodeAction(record.chosenAction),
    ...ordered.slice(0, 2).map((row) => row.actionId),
    returned[0]?.actionId,
    returned.find((row) => row.rootIndex !== null && !selected.has(row.rootIndex))?.actionId,
    returned.at(-1)?.actionId,
    ...ordered.map((row) => row.actionId),
    ...record.legalActions.map(encodeAction),
  ];
  return [...new Set(ids.filter((id): id is number => id !== undefined))].slice(
    0,
    limits.majorActions,
  );
}

export async function prepareLossAnalysis(directory: string, inputDirectory: string) {
  if (git("status", "--porcelain")) throw Error("コードをコミットしてから事前登録してください");
  if (relative(repoRoot, directory).startsWith(".."))
    throw Error("永続成果物はリポジトリ内のGit管理外領域へ保存してください");
  mkdirSync(directory, { recursive: false });
  for (const name of ["cases", "counterfactual", "diagnostics", "validation", "jobs"])
    mkdirSync(join(directory, name));
  const source = lossSourceIdentity();
  const prior = read<{ code: { source: string; runtimeSource: string }; options: unknown }>(
    join(inputDirectory, "plan.json"),
  );
  if (source.core !== prior.code.source || source.runtime !== prior.code.runtimeSource)
    throw Error("P1-4の探索/ルール/runtimeソースと一致しません");
  const startedAt = new Date().toISOString();
  const extracted = await extractLossCases(inputDirectory, directory);
  const cases = extracted.cases.map((record) => ({
    ...record,
    caseHash: hashJson(read<LossCase>(join(directory, "cases", record.id + ".json"))),
    sha256: new Bun.CryptoHasher("sha256")
      .update(readFileSync(join(directory, "cases", record.id + ".json")))
      .digest("hex"),
  }));
  const plan = {
    schemaVersion: 1,
    id: "p1-4b-loss-analysis-v1",
    registeredAt: new Date().toISOString(),
    extractionStartedAt: startedAt,
    source,
    referenceMeasurement: "e7b1af5e87d32039eb3c610438220b2726787de4",
    referenceSubmission: "ed749ce22355b37122f380302c8120863a915e10",
    inputDirectory: relative(repoRoot, inputDirectory),
    inputCheckpointSha256: extracted.inputCheckpointSha256,
    inputPlanHash: extracted.inputPlanHash,
    environment: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      os: release(),
      bun: Bun.version,
    },
    limits,
    cases,
    selection:
      "15敗退局の最後と一つ前の自手番。両方が強制手なら直近の非強制手も保持。各方式の最初の単独勝利局から4人/3人生存時の最後の非強制手を最大各1件。最後→一つ前→対照の固定順。",
    counterfactual:
      "全合法初手を列挙し、凍結Lv2/work2048が分岐後の合法局面から指し直す。本人の次手番/脱落/終局または8実手で停止。各初手同じ2秒上限、局面全体20秒。特定方針への復帰は全応手安全や勝利を意味しない。",
    fixed:
      "元の戦略・評価・既定幅6/根幅24/延長2/cache4096を維持。元がdeepの場合だけ記録済みopponentWidth/ownWidthを固定して根一手を比較。深さ2/4/6+記録深さ(最大9)、各段階100000work/2秒。同じ根で浅い完成反復を再利用。未完成以降は未実施。",
    intervention:
      "既存診断APIで同一節点へ実戦の合法応手1手だけ追加。既定の選別ルールは変更しない。完全終了した同深さの基準と介入だけを比較する。",
    finiteProof:
      "主要最大6初手を1/2/3/4実手先で検証。本人の将来手は存在量化、相手側は全合法手を全称量化。各問2500遷移/500ms、局面全体20秒。証明DAGを正本再生成して照合。未知/予算切れは安全・不可避としない。",
    historicalLimit:
      "元のログは上位3候補のみ。当時の全根/応手の採否は未記録。新しい計時観測・固定タスクの選別事実を過去の実行証明へ置き換えない。",
    noNewGames: true,
    noNewSeeds: true,
    noSearchOrEvaluationChange: true,
  };
  writeFileSync(join(directory, "plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  save(join(directory, "validation/input-replays.json"), {
    games: extracted.validations,
    allValid: true,
    caseCount: cases.length,
    lossGames: 15,
  });
  console.log(
    JSON.stringify({
      registered: true,
      cases: cases.length,
      lossCases: cases.filter((record) => record.kind === "loss").length,
      controls: cases.filter((record) => record.kind === "win-control").length,
      source: source.commit,
      planHash: hashJson(plan),
    }),
  );
  return plan;
}
type LossPlan = Awaited<ReturnType<typeof prepareLossAnalysis>>;
type ClassifiedLossCase = Pick<
  LossCase,
  | "gameId"
  | "kind"
  | "role"
  | "strategy"
  | "side"
  | "restricted"
  | "stateHash"
  | "pliesAfterChosenAction"
> & {
  caseId: string;
  alive: number;
  recordedDepth: number;
  legalMoves: number;
  labels: string[];
  evidence: Record<string, unknown>;
  finiteProofs: { attempted: number; verified: number; unknown: number };
  policyComplete: boolean;
  fixedRoots: number;
  originalDecisionSetRecovered: boolean;
};

export async function runLossAnalysis(directory: string) {
  const plan = read<LossPlan>(join(directory, "plan.json"));
  if (
    hashJson(plan.source) !== hashJson(lossSourceIdentity()) ||
    hashJson(plan.limits) !== hashJson(limits) ||
    git("status", "--porcelain")
  )
    throw Error("事前登録後にコードまたは条件が変わっています");
  const start = performance.now();
  writeFileSync(
    join(directory, "started.json"),
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid, planHash: hashJson(plan) }) +
      "\n",
    { flag: "wx" },
  );
  const active = new Map<ChildProcess, { pid: number; job: LossWorkerJob }>();
  let stopping = false,
    reason: string | null = null,
    maxDirectWorkers = 0;
  const failures: unknown[] = [];
  const terminate = (pid: number, signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const stop = () => {
    stopping = true;
    reason ??= "external_guard_or_signal";
    for (const { pid } of active.values()) {
      terminate(pid, "SIGTERM");
      setTimeout(() => terminate(pid, "SIGKILL"), 1000).unref();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const guard = spawn(
    "python3",
    [
      join(import.meta.dir, "lossAnalysisGuard.py"),
      "--pid",
      String(process.pid),
      "--directory",
      directory,
      "--wall-seconds",
      String(limits.wallMs / 1000),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  let closingGuard = false;
  const guardClosed = new Promise<void>((resolve) =>
    guard.once("exit", () => {
      if (!closingGuard) {
        reason = "guard_exited";
        stop();
      }
      resolve();
    }),
  );
  guard.once("error", (error) => {
    failures.push(String(error));
    stop();
  });
  const runJob = async (job: LossWorkerJob) => {
    if (stopping) return;
    const jobFile = join(directory, "jobs", `${job.output.split("/").at(-1)}.job.json`);
    writeFileSync(jobFile, JSON.stringify(job) + "\n", { flag: "wx" });
    appendFileSync(
      join(directory, "diagnostics/job-starts.jsonl"),
      JSON.stringify({
        mode: job.mode,
        caseHash: job.caseHash,
        output: relative(directory, job.output),
        at: new Date().toISOString(),
      }) + "\n",
    );
    await new Promise<void>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--no-env-file", join(import.meta.dir, "lossAnalysisWorker.ts"), jobFile],
        { cwd: repoRoot, detached: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      if (!child.pid) {
        failures.push({ output: relative(directory, job.output), reason: "spawn_failed" });
        resolve();
        return;
      }
      const pid = child.pid;
      active.set(child, { pid, job });
      maxDirectWorkers = Math.max(maxDirectWorkers, active.size);
      let stderr = "";
      child.stderr?.on("data", (value) => {
        stderr = (stderr + String(value)).slice(-16384);
      });
      const timer = setTimeout(() => {
        terminate(pid, "SIGTERM");
        setTimeout(() => terminate(pid, "SIGKILL"), 1000).unref();
      }, 45000);
      child.once("error", (error) => {
        failures.push(String(error));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        terminate(pid, "SIGKILL");
        active.delete(child);
        const entry = {
          output: relative(directory, job.output),
          code,
          signal,
          resultPresent: existsSync(job.output),
          stderr: stderr.replaceAll(repoRoot, "<REPO>"),
        };
        if (code !== 0 || !entry.resultPresent) failures.push(entry);
        appendFileSync(
          join(directory, "diagnostics/job-exits.jsonl"),
          JSON.stringify(entry) + "\n",
        );
        resolve();
      });
    });
  };
  const completed: string[] = [];
  try {
    const readyDeadline = performance.now() + 5000;
    while (!existsSync(join(directory, "diagnostics/guard-ready.json"))) {
      if (stopping || performance.now() > readyDeadline) throw Error("資源監視を開始できません");
      await Bun.sleep(20);
    }
    for (const item of plan.cases) {
      if (stopping || performance.now() - start > limits.wallMs - 30000) {
        reason ??= "wall_clock_limit";
        break;
      }
      if (hashJson(lossSourceIdentity()) !== hashJson(plan.source))
        throw Error("診断中にソースが変更されました");
      if (diskBytes(directory) > limits.maxOutputBytes) {
        reason = "output_limit";
        break;
      }
      const record = read<LossCase>(join(directory, "cases", item.id + ".json"));
      const base = {
        caseFile: join(directory, "cases", item.id + ".json"),
        caseHash: item.caseHash,
        sourceFingerprint: hashJson(plan.source),
      };
      const policyFile = join(directory, "counterfactual", item.id + "-policy.json");
      const runtimeFile = join(directory, "diagnostics", item.id + "-runtime.json");
      await runJob({ ...base, mode: "policy", output: policyFile });
      if (stopping) break;
      await runJob({ ...base, mode: "runtime", output: runtimeFile });
      if (stopping) break;
      const policy = output<LossPolicyResult>(policyFile),
        runtime = output<LossRuntimeResult>(runtimeFile);
      const major = selectMajorLossActions(record, policy?.rows ?? [], runtime);
      save(join(directory, "counterfactual", item.id + "-major.json"), {
        caseId: item.id,
        actionIds: major,
        policy:
          "chosen + shallow top2 + best returned + returned outside fresh selected roots + lowest-static returned; fill shallow order, maximum6",
      });
      for (let offset = 0; offset < major.length && !stopping; offset += limits.workers)
        await Promise.all(
          major.slice(offset, offset + limits.workers).map((actionId) =>
            runJob({
              ...base,
              mode: "fixed",
              policyFile,
              actionId,
              output: join(directory, "diagnostics", `${item.id}-fixed-${actionId}.json`),
            }),
          ),
        );
      if (stopping) break;
      await runJob({
        ...base,
        mode: "safety",
        policyFile,
        actionIds: major,
        output: join(directory, "counterfactual", item.id + "-safety.json"),
      });
      completed.push(item.id);
      save(join(directory, "checkpoint.json"), {
        completed,
        failures,
        reason,
        elapsedMs: performance.now() - start,
        maxDirectWorkers,
        planHash: hashJson(plan),
      });
      console.log(
        JSON.stringify({
          completed: completed.length,
          total: plan.cases.length,
          caseId: item.id,
          kind: item.kind,
          strategy: item.strategy,
          elapsedMs: performance.now() - start,
          failures: failures.length,
        }),
      );
    }
  } catch (error) {
    reason ??= "analysis_error";
    failures.push(String(error));
    stop();
  } finally {
    if (active.size) {
      stop();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    closingGuard = true;
    guard.kill("SIGTERM");
    await guardClosed;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    save(join(directory, "checkpoint.json"), {
      completed,
      failures,
      reason,
      elapsedMs: performance.now() - start,
      maxDirectWorkers,
      planHash: hashJson(plan),
      endedAt: new Date().toISOString(),
      sourceUnchanged: hashJson(plan.source) === hashJson(lossSourceIdentity()),
    });
  }
  summarizeLossAnalysis(directory);
}

export function summarizeLossAnalysis(directory: string) {
  const plan = read<LossPlan>(join(directory, "plan.json"));
  const cases: ClassifiedLossCase[] = [];
  for (const item of plan.cases) {
    const record = read<LossCase>(join(directory, "cases", item.id + ".json"));
    const policy = output<LossPolicyResult>(
      join(directory, "counterfactual", item.id + "-policy.json"),
    );
    const safety = output<LossSafetyResult>(
      join(directory, "counterfactual", item.id + "-safety.json"),
    );
    const runtime = output<LossRuntimeResult>(
      join(directory, "diagnostics", item.id + "-runtime.json"),
    );
    const majorFile = join(directory, "counterfactual", item.id + "-major.json");
    const major = existsSync(majorFile) ? read<{ actionIds: number[] }>(majorFile).actionIds : [];
    const fixed = major
      .map((id) =>
        output<LossFixedResult>(join(directory, "diagnostics", `${item.id}-fixed-${id}.json`)),
      )
      .filter((value): value is LossFixedResult => value !== null);
    const chosenId = encodeAction(record.chosenAction),
      chosenPolicy = policy?.rows.find((row) => row.actionId === chosenId);
    const conditional =
      policy?.rows
        .filter(
          (row) =>
            row.actionId !== chosenId &&
            (row.status === "returned" || row.status === "terminal_alive"),
        )
        .map((row) => row.actionId) ?? [];
    const actualFixed = fixed.find((row) => row.actionId === chosenId);
    const completedDepths =
      actualFixed?.results.filter((row) => row.candidate).map((row) => row.depth as number) ?? [];
    const omitted =
      actualFixed && "traceNodes" in actualFixed
        ? (actualFixed.traceNodes ?? []).filter(
            (node) =>
              node.samePosition &&
              node.legal &&
              node.row &&
              !node.row.selected &&
              completedDepths.includes(node.event.taskDepth),
          )
        : [];
    const labels: string[] = [];
    const evidence: Record<string, unknown> = {
      historicalRootAndReplySets: "unrecorded; original top3 only",
      conditionalEscapeActions: conditional,
      chosenPolicyStatus: chosenPolicy?.status ?? null,
      recordedPolicyPrefixMatches: chosenPolicy?.recordedPrefixMatches ?? null,
      controlledOmissions: omitted.map((node) => ({
        depth: node.event.taskDepth,
        turn: node.event.turn,
        side: node.expectedSide,
        action: node.expectedAction,
        reason: node.row?.reason,
        staticRank: node.row?.staticRank,
        path: node.event.path,
        stateHash: node.stateHash,
      })),
    };
    const selectedRoots = new Set<number>();
    for (const entry of runtime?.trace.iterations ?? []) {
      const iteration = entry as { depth: number; roots: number[] };
      if (iteration.depth === runtime?.snapshot.completedDepth)
        for (const index of iteration.roots) selectedRoots.add(index);
    }
    const omittedEscapes =
      policy?.rows.filter(
        (row) =>
          conditional.includes(row.actionId) &&
          row.rootIndex !== null &&
          selectedRoots.size > 0 &&
          !selectedRoots.has(row.rootIndex),
      ) ?? [];
    if (omittedEscapes.length) {
      labels.push("根候補選別の可能性（新観測のみ）");
      evidence.freshReplayOmittedConditionalEscapes = omittedEscapes.map((row) => ({
        actionId: row.actionId,
        staticRank: row.staticRank,
        rootIndex: row.rootIndex,
      }));
    }
    if (omitted.some((node) => node.expectedSide !== record.side))
      labels.push("相手応手選別の可能性（固定再現）");
    if (omitted.some((node) => node.expectedSide === record.side))
      labels.push("自手継続選別の可能性（固定再現）");
    const required = (record.pliesAfterChosenAction ?? Infinity) + 1;
    const certificates = safety?.rows.filter((row) => row.validation.verified) ?? [];
    const finite = [];
    for (const chosen of certificates.filter(
      (row) =>
        row.actionId === chosenId && row.proof.status === "unsafe" && row.horizon >= required,
    ))
      for (const alternative of certificates.filter(
        (row) =>
          row.actionId !== chosenId &&
          row.horizon === chosen.horizon &&
          row.proof.status === "safe",
      ))
        finite.push({ horizon: chosen.horizon, alternative: alternative.actionId });
    if (finite.length) labels.push("指定有限範囲で回避可能（全合法応手証明）");
    evidence.finiteAvoidance = finite;
    if (
      chosenPolicy?.status === "eliminated" &&
      chosenPolicy.recordedPrefixMatches &&
      conditional.length
    )
      labels.push("凍結Lv2方針に対する次自手番復帰が可能");
    const deathDepths =
      actualFixed?.results
        .filter((row) => {
          const candidate = row.candidate as StudyCandidate | undefined;
          return candidate?.line.some((step) =>
            step.eliminations.some((elimination) => elimination.side === record.side),
          );
        })
        .map((row) => row.depth) ?? [];
    evidence.deathVisibleAtCompletedDepths = deathDepths;
    if (deathDepths.length && completedDepths.some((depth) => depth < (deathDepths[0] as number)))
      labels.push("探索地平の可能性（同条件深さ比較）");
    evidence.evaluationCause = "静的内訳と選択PVだけでは不当評価を確定できない";
    evidence.finiteForcedLoss = limits.safetyHorizons.filter((horizon) =>
      record.legalActions.every((action) =>
        certificates.some(
          (row) =>
            row.horizon === horizon &&
            row.actionId === encodeAction(action) &&
            row.proof.status === "unsafe",
        ),
      ),
    );
    if (!labels.length) labels.push("回避困難・未確定");
    cases.push({
      caseId: item.id,
      gameId: item.gameId,
      kind: record.kind,
      role: record.role,
      strategy: record.strategy,
      side: record.side,
      restricted: record.restricted,
      stateHash: record.stateHash,
      alive: record.activeSides.length,
      recordedDepth: record.recordedChoice.depth,
      legalMoves: record.legalActions.length,
      pliesAfterChosenAction: record.pliesAfterChosenAction,
      labels,
      evidence,
      finiteProofs: {
        attempted: safety?.rows.length ?? 0,
        verified: certificates.length,
        unknown: safety?.rows.filter((row) => row.proof.status === "unknown").length ?? 0,
      },
      policyComplete: policy?.complete ?? false,
      fixedRoots: fixed.length,
      originalDecisionSetRecovered: false,
    });
  }
  const games = [
    ...new Set(cases.filter((row) => row.kind === "loss").map((row) => row.gameId)),
  ].map((gameId) => {
    const rows = cases.filter((row) => row.gameId === gameId),
      last = rows.find((row) => row.role === "last")!;
    return {
      gameId,
      strategy: last.strategy,
      side: last.side,
      restricted: last.restricted,
      cases: rows.map((row) => row.caseId),
      labels: [...new Set(rows.flatMap((row) => row.labels))],
      finiteAvoidable: rows.some((row) => (row.evidence.finiteAvoidance as unknown[]).length > 0),
      policyConditionalAvoidance: rows.some((row) =>
        row.labels.includes("凍結Lv2方針に対する次自手番復帰が可能"),
      ),
    };
  });
  const report = {
    schemaVersion: 1,
    planHash: hashJson(plan),
    source: plan.source,
    statisticalUnit: "used seed9874100; all15 losses from one correlated series",
    games,
    cases,
    counts: {
      lossGames: games.length,
      lossCases: cases.filter((row) => row.kind === "loss").length,
      controls: cases.filter((row) => row.kind === "win-control").length,
      finiteAvoidableGames: games.filter((row) => row.finiteAvoidable).length,
      policyConditionalAvoidableGames: games.filter((row) => row.policyConditionalAvoidance).length,
    },
    limitations: [
      "元の全枝は未記録。固定/新計時観測の採否を過去の実行証明へ置換しない。",
      "有限生存の証明は勝利・最善手・無限安全を意味しない。",
      "選択探索や凍結方針への生存を全合法応手安全や不可避性へ読み替えない。",
      "静的評価内訳だけで評価係数の欠陥を確定しない。",
    ],
  };
  save(join(directory, "cases/summary.json"), report);
  return report;
}

if (import.meta.main) {
  const [mode, directory, input] = Bun.argv.slice(2);
  if (!directory)
    throw Error("prepare|run|summarize <成果物ディレクトリ> [P1-4主比較ディレクトリ]");
  if (mode === "prepare") await prepareLossAnalysis(resolve(directory), resolve(input));
  else if (mode === "run") await runLossAnalysis(resolve(directory));
  else if (mode === "summarize")
    console.log(JSON.stringify(summarizeLossAnalysis(resolve(directory)).counts));
  else throw Error("不明なmodeです");
}
