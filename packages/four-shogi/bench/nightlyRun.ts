import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, writeFileSync, statfsSync } from "node:fs";
import { repoRoot } from "./baseline";
import { nightlyConfig, nightlySource, type NightlyConfig } from "./nightlyConfig";
import {
  atomicJson,
  immutableJson,
  readJson,
  initializeNightlyRoot,
  currentGeneration,
  registerGeneration,
  appendNightEvent,
  type GenerationManifest,
} from "./nightlyStore";
import { fileSha, type QualitySummary } from "./nightlySnapshot";
import { NightlySupervisor, type StageUsage } from "./nightlyResources";
import { sameData } from "./selfPlayData";
import { sides } from "../src/types";
import { promotionDecision, type ComparisonPlan } from "./nightlyCompare";
import { historicalSeeds } from "./nightlySeeds";
import { saveNightlyArtifacts } from "./nightlyArtifacts";

type CatalogEntry = { night: string; path: string; datasetId: string; manifestSha256: string };
type Plan = {
  format: "four-shogi-nightly-plan-v1";
  id: string;
  createdAt: string;
  source: ReturnType<typeof nightlySource>;
  config: NightlyConfig;
  parent: GenerationManifest;
  trainSeeds: number[];
  validationSeeds: number[];
  screenSeeds: number[];
  confirmSeeds: number[];
  snapshotSources: string[];
  candidateId: string;
  historicalSeedScan: ReturnType<typeof historicalSeeds>["summary"];
};
type State = {
  id: string;
  status: "running" | "paused" | "held" | "completed" | "failed";
  stage: string;
  reason: string | null;
  completed: Record<string, { report: string; sha256: string }>;
  updatedAt: string;
  candidateId: string | null;
  decision: unknown;
  resources: StageUsage[];
  activeStartedAt?: number | null;
  recoveredWallMs?: number;
};
export type NightlyOptions = {
  root: string;
  config?: unknown;
  smoke?: boolean;
  engineering?: boolean;
  resume?: boolean;
  allowDirty?: boolean;
  stopAfter?: string;
  signal?: AbortSignal;
};

function freeDisk(root: string, minGiB: number) {
  let path = root;
  while (!existsSync(path)) {
    const parent = resolve(path, "..");
    if (parent === path) throw new Error("保存先の空き容量を確認できません");
    path = parent;
  }
  const fs = statfsSync(path);
  if (fs.bavail * fs.bsize < minGiB * 1024 ** 3)
    throw new Error("disk_limit: nightlyを開始する空き容量がありません");
}
function allocateSeeds(count: number, min: number, max: number, used: Set<number>) {
  const out: number[] = [];
  while (out.length < count) {
    if (used.size >= 100000) throw new Error("seed台帳の上限です");
    const value = min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min + 1));
    if (!used.has(value)) {
      used.add(value);
      out.push(value);
    }
  }
  return out;
}
export async function runNightly(options: NightlyOptions) {
  const root = resolve(options.root),
    source = nightlySource();
  if (source.code.dirty && !options.allowDirty)
    throw new Error(
      "生成/学習ソースをコミットしてください。動作実験だけ--allow-dirtyを指定できます",
    );
  const proposed = nightlyConfig(options.config ?? {}, options.smoke);
  if (options.engineering) proposed.engineering = true;
  freeDisk(root, proposed.minFreeGiB);
  const lock = initializeNightlyRoot(root);
  let state: State | undefined, plan: Plan | undefined, supervisor: NightlySupervisor | undefined;
  let directory = "",
    reportDirectory = "";
  try {
    const latestPath = join(root, "latest-night.json"),
      catalogPath = join(root, "dataset-catalog.json"),
      ledgerPath = join(root, "seed-ledger.json");
    const catalog: CatalogEntry[] = existsSync(catalogPath) ? readJson(catalogPath) : [];
    for (const entry of catalog)
      if (fileSha(join(entry.path, "manifest.json")) !== entry.manifestSha256)
        throw new Error("確定済みdatasetのmanifestが変更されています");
    if (options.resume) {
      if (!existsSync(latestPath)) throw new Error("再開するnightly runがありません");
      const latest = readJson<{ id: string }>(latestPath);
      directory = join(root, "runs", latest.id);
      const priorPlan = readJson<Plan>(join(directory, "plan.json"));
      const priorState = readJson<State>(join(directory, "state.json"));
      if (["completed", "held"].includes(priorState.status))
        throw new Error("この夜は終了済みです。翌夜の新しいrunを開始してください");
      plan = priorPlan;
      state = priorState;
      if (plan.source.fingerprint !== source.fingerprint)
        throw new Error(
          "再開元と探索/runner/学習コード/環境が異なります。別の夜を開始してください",
        );
      if (options.config !== undefined && !sameData(proposed, plan.config))
        throw new Error("同一夜の再開条件を変更できません");
      const active = currentGeneration(root);
      if (active.id !== plan.parent.id) {
        if (
          active.id === plan.candidateId &&
          state.candidateId === active.id &&
          state.completed.comparison &&
          state.completed.tactics &&
          state.completed.inference
        ) {
          for (const receipt of Object.values(state.completed))
            if (fileSha(receipt.report) !== receipt.sha256)
              throw new Error("昇格回復の検証receiptが不一致です");
          state.status = "completed";
          state.reason = "昇格参照更新後の中断を回復しました";
          state.updatedAt = new Date().toISOString();
          appendNightEvent(join(directory, "events.jsonl"), {
            at: state.updatedAt,
            status: state.status,
            stage: state.stage,
            reason: state.reason,
          });
          return state;
        }
        throw new Error("再開元の親世代と現役が不一致です");
      }
    } else {
      const numbers = readdirSync(join(root, "runs")).flatMap((name) =>
          /^night-(\d+)$/.test(name) ? [Number(name.slice(6))] : [],
        ),
        id = "night-" + String(Math.max(0, ...numbers) + 1).padStart(4, "0");
      directory = join(root, "runs", id);
      mkdirSync(directory);
      const parent = currentGeneration(root);
      const ledger: number[] = existsSync(ledgerPath) ? readJson(ledgerPath) : [];
      const history = historicalSeeds([
        join(repoRoot, "docs"),
        join(repoRoot, ".study-measurements"),
      ]);
      const used = new Set([...ledger, ...history.values, 18900, 19000, 41701, 51701, 59000]);
      const config = proposed;
      plan = {
        format: "four-shogi-nightly-plan-v1",
        id,
        createdAt: new Date().toISOString(),
        source,
        config,
        parent,
        trainSeeds: allocateSeeds(config.trainFamilies, 10000, 39999, used),
        validationSeeds: allocateSeeds(config.validationFamilies, 50000, 56999, used),
        screenSeeds: allocateSeeds(1, 47000, 47999, used),
        confirmSeeds: allocateSeeds(4, 48000, 48999, used),
        snapshotSources: catalog.slice(-config.replayNights).map((e) => e.path),
        candidateId: `g${String(parent.generation + 1).padStart(3, "0")}-candidate-${id}`,
        historicalSeedScan: history.summary,
      };
      atomicJson(
        ledgerPath,
        [...used].sort((a, b) => a - b),
      );
      immutableJson(join(directory, "plan.json"), plan);
      state = {
        id,
        status: "running",
        stage: "preflight",
        reason: null,
        completed: {},
        updatedAt: new Date().toISOString(),
        candidateId: null,
        decision: null,
        resources: [],
      };
      atomicJson(latestPath, { id });
    }
    const fixed = plan!,
      status = state!,
      config = fixed.config;
    reportDirectory = join(root, "reports", fixed.id);
    mkdirSync(reportDirectory, { recursive: true });
    const save = () => {
      status.updatedAt = new Date().toISOString();
      appendNightEvent(join(directory, "events.jsonl"), {
        at: status.updatedAt,
        status: status.status,
        stage: status.stage,
        reason: status.reason,
        completed: Object.keys(status.completed),
        candidateId: status.candidateId,
      });
      atomicJson(join(directory, "state.json"), status);
    };
    status.status = "running";
    status.reason = null;
    if (status.activeStartedAt) {
      status.recoveredWallMs =
        (status.recoveredWallMs ?? 0) +
        Math.min(config.maxRunMs, Math.max(0, Date.now() - status.activeStartedAt));
      status.activeStartedAt = null;
    }
    const consumed =
      status.resources.reduce((n, r) => n + r.elapsedMs, 0) + (status.recoveredWallMs ?? 0);
    if (consumed >= config.maxRunMs)
      throw new Error("この夜の累積時間上限です。確定データを保持して終了します");
    save();
    supervisor = new NightlySupervisor(
      {
        maxRunMs: Math.max(1, Math.floor(config.maxRunMs - consumed)),
        maxRssBytes: config.maxRssMb * 1024 ** 2,
        hardRssBytes: config.hardRssMb * 1024 ** 2,
        minFreeBytes: config.minFreeGiB * 1024 ** 3,
      },
      root,
      options.signal,
    );
    const report = (name: string) => join(reportDirectory, name + ".json");
    const step = async (name: string, command: string[]) => {
      if (nightlySource().fingerprint !== fixed.source.fingerprint)
        throw new Error("実行中に探索/学習ソースが変更されました");
      const prior = status.completed[name];
      if (prior) {
        if (fileSha(prior.report) !== prior.sha256)
          throw new Error("工程結果のchecksumが不一致です");
        return readJson<any>(prior.report);
      }
      status.stage = name;
      status.activeStartedAt = Date.now();
      save();
      const usage = await supervisor!.run(
        name,
        command,
        join(reportDirectory, name + ".log"),
        join(reportDirectory, name + "-resources.json"),
      );
      if (nightlySource().fingerprint !== fixed.source.fingerprint)
        throw new Error("工程の実行中にコードが変更されました。結果を採用せず保持します");
      status.resources.push(usage);
      status.activeStartedAt = null;
      if (!existsSync(report(name))) throw new Error(`${name}: 完了報告がありません`);
      status.completed[name] = { report: report(name), sha256: fileSha(report(name)) };
      save();
      if (options.stopAfter === name) throw new Error("requested_stop_after:" + name);
      return readJson<any>(report(name));
    };
    const bun = (file: string, ...args: string[]) => [
      process.execPath,
      join(repoRoot, "packages/four-shogi/bench", file),
      ...args,
    ];
    const python = (file: string, ...args: string[]) => [
      config.python,
      join(repoRoot, "training/four-shogi-ai", file),
      ...args,
    ];
    const preflightCode =
      "import json,sys,platform,torch;from pathlib import Path;assert sys.version_info[:2]==(3,12),'Python 3.12が必要です';assert str(torch.__version__).split('+')[0]=='2.14.1','PyTorch版が不一致です';Path(sys.argv[1]).write_text(json.dumps({'python':sys.version,'torch':str(torch.__version__),'platform':platform.platform(),'mpsAvailable':torch.backends.mps.is_available()}))";
    await step("preflight", [config.python, "-c", preflightCode, report("preflight")]);
    const currentModel =
      fixed.parent.localModelFile && fixed.parent.modelId
        ? {
            modelFile: fixed.parent.localModelFile,
            modelId: fixed.parent.modelId,
            modelSha256: fixed.parent.localModelSha256 ?? undefined,
          }
        : {};
    const generated = join(root, "datasets", fixed.id + "-games"),
      teachers = join(root, "datasets", fixed.id + "-teachers");
    const generationConfig = {
      origins: [...fixed.trainSeeds, ...fixed.validationSeeds].map((seed) => ({ seed })),
      restrictions: [true],
      seatOffsets: config.seats === 4 ? sides : ["south"],
      agents: [
        { id: "active", kind: "study", options: { maxWork: config.actorWork, ...currentModel } },
        { id: "light", kind: "analysis", options: { maxWork: 128, extensions: 0 } },
        { id: "medium", kind: "analysis", options: { maxWork: 1024 } },
        { id: "lv2", kind: "cpu", reference: "frozen" },
      ],
      lineups:
        config.seats === 4
          ? [
              ["active", "lv2", "light", "lv2"],
              ["medium", "lv2", "active", "light"],
            ]
          : [["light", "lv2", "active", "lv2"]],
      teacher: { maxWork: 1, dangerWork: 0 },
      sampling: { every: 0, important: false, maxPositions: 0 },
      maxPlies: config.maxPlies,
    };
    const genPath = join(directory, "generation-config.json");
    immutableJson(genPath, generationConfig);
    const generation = await step(
      "generation",
      bun(
        "selfPlayCli.ts",
        `--config=${genPath}`,
        `--output=${generated}`,
        "--concurrency=1",
        "--max-games=512",
        `--max-bytes=${1024 ** 3}`,
        `--max-rss-mb=${config.maxRssMb}`,
        `--max-run-ms=${Math.max(1, Math.floor(supervisor.remaining() - 1000))}`,
        `--report=${report("generation")}`,
        ...(options.allowDirty ? ["--allow-dirty=true"] : []),
      ),
    );
    if (!generation.complete) {
      delete status.completed.generation;
      status.status = "paused";
      status.reason = generation.stopReason ?? "生成未完了";
      save();
      return status;
    }
    const teachConfigPath = join(directory, "teacher-config.json");
    immutableJson(teachConfigPath, {
      teacher: { maxWork: config.teacherWork, ...currentModel },
      maxPositions: config.teacherPositions,
      selection: config.teacherSelection,
    });
    const teaching = await step(
      "teachers",
      bun("nightlyTeacher.ts", generated, teachers, teachConfigPath, report("teachers")),
    );
    if (!catalog.some((e) => e.datasetId === teaching.datasetId)) {
      catalog.push({
        night: fixed.id,
        path: teachers,
        datasetId: teaching.datasetId,
        manifestSha256: fileSha(join(teachers, "manifest.json")),
      });
      atomicJson(catalogPath, catalog);
    }
    const snapshot = join(root, "snapshots", fixed.id),
      snapshotConfig = join(directory, "snapshot-config.json");
    const ledger: number[] = readJson(ledgerPath);
    immutableJson(snapshotConfig, {
      sources: [...fixed.snapshotSources, teachers],
      destination: snapshot,
      excludedSeeds: ledger.filter((n) => n >= 47000 && n < 49000),
    });
    const data = await step(
      "snapshot",
      bun("nightlyStep.ts", "snapshot", snapshotConfig, report("snapshot")),
    );
    const quality = data.quality as QualitySummary;
    if (!quality.eligible && !config.engineering) {
      status.status = "held";
      status.reason = "データ品質不足。次の夜に新しい棋譜を追加してください";
      status.decision = { decision: "hold", reasons: quality.reasons };
      save();
      return status;
    }
    if (
      !quality.splits.train ||
      (!quality.splits.train.values.some((v) => v > 0) && !config.policyOnly)
    )
      throw new Error("Value教師がありません。Value込み世代は作成せず停止します");
    const device = await step(
      "device",
      python("deviceBenchmark.py", `--data=${snapshot}`, `--report=${report("device")}`),
    );
    const selected = config.device === "auto" ? device.selected : config.device;
    if (device.results[selected]?.status !== "completed")
      throw new Error(`要求した学習device ${selected} を利用できません。黙って切り替えません`);
    const candidateRoot = join(root, "generations", fixed.candidateId),
      checkpoint = join(candidateRoot, "checkpoint");
    mkdirSync(candidateRoot, { recursive: true });
    const parent = fixed.parent;
    const trained = await step(
      "training",
      python(
        "train.py",
        `--data=${snapshot}`,
        `--output=${checkpoint}`,
        `--steps=${config.trainingSteps}`,
        "--width=32",
        "--history-width=8",
        "--threads=1",
        "--checkpoint-every=100",
        `--device=${selected}`,
        `--max-seconds=${Math.max(1, Math.floor(supervisor.remaining() / 1000))}`,
        `--report=${report("training")}`,
        ...(parent.checkpointDirectory && parent.checkpointSha256
          ? [
              `--warm-start=${parent.checkpointDirectory}`,
              `--warm-start-sha256=${parent.checkpointSha256}`,
            ]
          : []),
        ...(typeof parent.validation.snapshotDirectory === "string"
          ? [`--replay-validation=${parent.validation.snapshotDirectory}`]
          : []),
        ...(config.policyOnly ? ["--allow-policy-only"] : []),
        ...(options.allowDirty ? ["--allow-dirty"] : []),
      ),
    );
    if (trained.status !== "completed") {
      delete status.completed.training;
      status.status = "paused";
      status.reason = "学習step未完了。checkpointから再開できます";
      save();
      return status;
    }
    await step("fixture", bun("nightlyStep.ts", "fixture", snapshotConfig, report("fixture")));
    const modelDirectory = join(candidateRoot, "model");
    await step(
      "export",
      python(
        "nightlyExport.py",
        `--checkpoint=${checkpoint}`,
        `--output=${modelDirectory}`,
        `--fixture=${report("fixture")}`,
        `--report=${report("export")}`,
      ),
    );
    const inference = await step(
      "inference",
      bun(
        "nightlyInferenceProbe.ts",
        modelDirectory,
        config.python,
        report("fixture"),
        report("inference"),
      ),
    );
    if (!inference.passed) throw new Error("推論検証gateに失敗しました");
    const manifest: GenerationManifest = {
      format: "four-shogi-generation-v1",
      id: fixed.candidateId,
      generation: parent.generation + 1,
      state: "candidate",
      createdAt: fixed.createdAt,
      parentId: parent.id,
      parentCheckpointSha256: parent.checkpointSha256,
      modelId: trained.modelId,
      checkpointSha256: trained.checkpointSha256,
      localModelFile: join(modelDirectory, "local-model.json"),
      localModelSha256: fileSha(join(modelDirectory, "local-model.json")),
      checkpointDirectory: checkpoint,
      snapshotId: data.datasetId,
      trainingSamples: data.samples.count,
      validation: {
        snapshotDirectory: snapshot,
        replayValidation: trained.history.at(-1)?.replayValidation ?? null,
        engineeringOnly: config.engineering,
        policyOnly: config.policyOnly,
        train: trained.history.at(-1)?.train,
        validation: trained.history.at(-1)?.validation,
        inference: inference.passed,
      },
      qualified: quality.eligible && !config.policyOnly && !config.engineering,
    };
    registerGeneration(root, manifest);
    status.candidateId = manifest.id;
    save();
    if (!manifest.qualified || !config.compare) {
      status.status = "held";
      status.reason = !manifest.qualified
        ? "動作試験用モデル。品質/棋力の昇格条件は未達です"
        : "比較未実施の候補モデルを保存しました";
      status.decision = { decision: "hold", reasons: [status.reason] };
      save();
      return status;
    }
    const tactics = await step(
      "tactics",
      bun(
        "nightlyValidation.ts",
        join(candidateRoot, "validation"),
        join(candidateRoot, "generation.json"),
        report("tactics"),
      ),
    );
    if (tactics.critical.passed !== 40 || tactics.known.passed !== 8 || !tactics.resourcePassed) {
      status.status = "held";
      status.reason = "戦術/資源gate未達。候補を保存して現役を維持します";
      status.decision = { decision: "hold", reasons: [status.reason] };
      save();
      return status;
    }
    const comparisonPlan: ComparisonPlan = {
      format: "four-shogi-generation-comparison-v1",
      sourceFingerprint: fixed.source.fingerprint,
      parent,
      candidate: manifest,
      screenSeeds: fixed.screenSeeds,
      confirmSeeds: fixed.confirmSeeds,
      timeBudgetMs: config.comparisonMs,
      threads: 4,
      maxPlies: config.comparisonMaxPlies,
      restriction: true,
      opponent: "frozen",
    };
    const comparisonPlanPath = join(directory, "comparison-plan.json");
    immutableJson(comparisonPlanPath, comparisonPlan);
    const comparison = await step(
      "comparison",
      bun(
        "nightlyCompare.ts",
        join(candidateRoot, "comparison"),
        comparisonPlanPath,
        report("comparison"),
      ),
    );
    const decision = promotionDecision({
      qualified: manifest.qualified,
      criticalPassed: tactics.critical.passed,
      criticalTotal: tactics.critical.total,
      knownPassed: tactics.known.passed,
      knownTotal: tactics.known.total,
      resourcePassed:
        tactics.resourcePassed &&
        comparison.resourcePassed &&
        !status.resources.some(
          (usage) => usage.stopReason !== null && usage.stopReason !== "cancelled",
        ),
      summary: comparison.confirmation,
      timeBudgetMs: config.comparisonMs,
      threads: 4,
    });
    status.decision = decision;
    if (decision.decision === "promote") {
      if (currentGeneration(root).id !== parent.id)
        throw new Error("昇格直前に現役世代が変更されました");
      immutableJson(join(candidateRoot, "promotion.json"), {
        parentId: parent.id,
        modelId: manifest.modelId,
        decision,
        comparisonSha256: fileSha(report("comparison")),
        tacticsSha256: fileSha(report("tactics")),
      });
      atomicJson(join(root, "current.json"), {
        id: manifest.id,
        modelId: manifest.modelId,
        generationManifestSha256: fileSha(join(candidateRoot, "generation.json")),
      });
      status.status = "completed";
      status.reason = "事前登録の暫定昇格条件を通過。統計的な棋力保証ではありません";
    } else {
      status.status = "held";
      status.reason = decision.reasons.join(" / ");
    }
    save();
    return status;
  } catch (error) {
    if (state) {
      state.status =
        options.signal?.aborted || String(error).includes("requested_stop_after:")
          ? "paused"
          : "failed";
      state.reason = String(error);
      appendNightEvent(join(directory, "events.jsonl"), {
        at: new Date().toISOString(),
        status: state.status,
        stage: state.stage,
        reason: state.reason,
      });
      state.updatedAt = new Date().toISOString();
      atomicJson(join(directory, "state.json"), state);
    }
    throw error;
  } finally {
    try {
      if (state && plan) {
        const usage = new Map(
          [...state.resources, ...(supervisor?.records ?? [])].map((r) => [
            r.startedAt + ":" + r.name,
            r,
          ]),
        );
        state.resources = [...usage.values()];
        if (supervisor?.records.length) state.activeStartedAt = null;
        atomicJson(join(directory, "state.json"), state);
        const stageReports: Record<string, any> = {},
          reportErrors: Record<string, string> = {};
        for (const [name, receipt] of Object.entries(state.completed)) {
          try {
            if (fileSha(receipt.report) !== receipt.sha256)
              throw new Error("工程報告のchecksumが不一致です");
            stageReports[name] = readJson(receipt.report);
          } catch (error) {
            reportErrors[name] = String(error);
          }
        }
        const training = stageReports.training;
        const measurements = {
          newGames: stageReports.generation ?? null,
          teacherDataset: stageReports.teachers ?? null,
          accumulatedSnapshot: stageReports.snapshot ?? null,
          training: training
            ? {
                step: training.step,
                modelId: training.modelId,
                parent: training.parent,
                device: training.device,
                elapsedSeconds: training.elapsedSeconds,
                cpuSeconds: training.cpuSeconds,
                maxRssBytes: training.maxRssBytes,
                finalMetrics: training.history.at(-1) ?? null,
              }
            : null,
          inference: stageReports.inference ?? null,
          tactics: stageReports.tactics ?? null,
          comparison: stageReports.comparison ?? null,
          resources: {
            elapsedStageMs: state.resources.reduce((n, r) => n + r.elapsedMs, 0),
            sampledCpuSeconds: state.resources.reduce((n, r) => n + r.sampledCpuSeconds, 0),
            peakRssBytes: Math.max(0, ...state.resources.map((r) => r.peakRssBytes)),
            recoveredWallMs: state.recoveredWallMs ?? 0,
          },
          reportErrors,
        };
        const result = {
          format: "four-shogi-nightly-report-v1",
          plan,
          state,
          resources: state.resources,
          measurements,
          cpuObservation:
            "ps採取のPID別累積最大。短命プロセスを含む厳密な総CPU時間の下限であり、GPU時間ではありません",
          sourceUnchanged: nightlySource().fingerprint === plan.source.fingerprint,
        };
        atomicJson(join(reportDirectory || join(root, "reports", plan.id), "summary.json"), result);
        writeFileSync(
          join(reportDirectory || join(root, "reports", plan.id), "summary.md"),
          `# ${plan.id}\n\n状態: ${state.status}\n工程: ${state.stage}\n理由: ${state.reason ?? "なし"}\n親: ${plan.parent.id}\n候補: ${state.candidateId ?? "未作成"}\nコード: ${plan.source.code.commit}\n\n実行済み: ${Object.keys(state.completed).join(", ")}\n\n今夜の新規棋譜と、過去の夜を含むsnapshotを分けて記録します。未実行工程はnullです。教師のThisInvocationは最後の工程呼出の費用で、再開前の費用は資源履歴にも保持します。\n\n\`\`\`json\n${JSON.stringify(measurements, null, 2)}\n\`\`\`\n\n学習成功・推論検証・棋力改善は別の判定です。CPU観測は短命プロセスを取りこぼす下限で、GPU時間ではありません。詳細は各工程JSONとstate.jsonを参照してください。\n`,
        );
        saveNightlyArtifacts(
          root,
          [
            directory,
            reportDirectory || join(root, "reports", plan.id),
            join(root, "datasets", plan.id + "-games"),
            join(root, "datasets", plan.id + "-teachers"),
            join(root, "snapshots", plan.id),
            join(root, "generations", plan.candidateId),
          ],
          join(reportDirectory || join(root, "reports", plan.id), "manifest.json"),
          { commit: plan.source.code.commit, fingerprint: plan.source.fingerprint },
        );
      }
    } finally {
      lock.release();
    }
  }
}
