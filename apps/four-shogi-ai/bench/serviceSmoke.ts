import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { restoreAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import type { AiResult } from "@tetraboard/four-shogi/ai";
import {
  aiJobRequestSchema,
  aiRequestFingerprint,
  createAiRequestId,
  aiJobSnapshotSchema,
  aiServiceHealthSchema,
  type AiJobRequest,
} from "@tetraboard/protocol/four-shogi-ai";

const args = Object.fromEntries(
  process.argv.slice(2).map((v) => {
    const index = v.indexOf("=");
    if (!v.startsWith("--") || index < 3) throw new Error("key=value arguments required");
    return [v.slice(2, index), v.slice(index + 1)];
  }),
);
assert(
  Object.keys(args).every((k) =>
    ["python", "model-dir", "code-version", "output", "port"].includes(k),
  ),
);
assert(
  args.python &&
    args["model-dir"] &&
    /^[0-9a-f]{40}$/.test(args["code-version"] ?? "") &&
    args.output,
);
const modelDirectory = resolve(args["model-dir"]),
  codeVersion = args["code-version"],
  port = Number(args.port ?? 8790);
assert(!(await Bun.file(args.output).exists()));
const manifestFile = Bun.file(resolve(modelDirectory, "manifest.json"));
assert(manifestFile.size < 262144);
const manifest = await manifestFile.json();
const secret = [...crypto.getRandomValues(new Uint8Array(32))]
  .map((v) => v.toString(16).padStart(2, "0"))
  .join("");
const base = `http://127.0.0.1:${port}`;
const observations: object[] = [],
  phases: {
    startupMs: number;
    logs: object[];
    stopMs?: number;
    exitCode?: number | null;
    afterStopProcesses?: number;
  }[] = [];
async function timeout<T>(promise: Promise<T>, ms = 15000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("smoke_timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function launch() {
  const started = performance.now(),
    logs: object[] = [];
  const child = spawn(
    process.execPath,
    ["--no-env-file", new URL("../src/main.ts", import.meta.url).pathname],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        AI_CODE_VERSION: codeVersion,
        AI_SHARED_SECRET: secret,
        AI_MODEL_DIRECTORY: modelDirectory,
        AI_PYTHON: args.python,
        AI_PORT: String(port),
        AI_MAX_QUEUE_ANALYSIS: "1",
        AI_ANALYSIS_REQUESTS: "2",
      },
    },
  );
  let buffer = "",
    stderrBytes = 0;
  let readyResolve: () => void = () => {},
    readyReject: (reason: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    assert(buffer.length < 1048576);
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const entry = JSON.parse(line);
      logs.push(entry);
      if (entry.event === "service_ready") readyResolve();
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      readyReject(new Error("service_startup_failed"));
      resolve(code);
    }),
  );
  try {
    await timeout(ready);
  } catch (error) {
    child.kill("SIGTERM");
    await timeout(exited, 5000).catch(() => child.kill("SIGKILL"));
    throw error;
  }
  const phase = {
    startupMs: performance.now() - started,
    logs,
    stopMs: undefined as number | undefined,
    exitCode: undefined as number | null | undefined,
    afterStopProcesses: undefined as number | undefined,
  };
  phases.push(phase);
  return { child, exited, phase, stderr: () => stderrBytes };
}
async function verifyStopped(phase: (typeof phases)[number]) {
  const pids = [
    ...new Set(
      phase.logs
        .filter((v) => (v as { event?: string }).event === "compute_ready")
        .flatMap((v) => {
          const row = v as { pid: number; modelPid: number };
          return [row.pid, row.modelPid];
        }),
    ),
  ];
  assert(pids.length >= 4);
  const remaining = () =>
    pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const started = performance.now();
  while (remaining().length && performance.now() - started < 1000) await Bun.sleep(10);
  phase.afterStopProcesses = remaining().length;
  assert.equal(phase.afterStopProcesses, 0);
}
function summary(value: unknown) {
  const parsed = aiJobSnapshotSchema.safeParse(value);
  if (!parsed.success) return value;
  const { result, ...snapshot } = parsed.data;
  const ai = result as AiResult | null;
  return {
    ...snapshot,
    result: ai
      ? {
          input: ai.input,
          versions: ai.versions,
          model: ai.model,
          diagnostics: ai.diagnostics,
          evaluation: ai.evaluation,
          recommendedAction: ai.recommendedAction,
        }
      : null,
  };
}
async function call(
  label: string,
  path: string,
  method = "GET",
  body?: unknown,
  principal?: string,
  instance?: string,
  record = true,
  token = secret,
) {
  const started = performance.now();
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      ...(principal ? { "x-ai-principal": principal } : {}),
      ...(instance ? { "x-ai-instance": instance } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const data: unknown = await response.json(),
    wallMs = performance.now() - started;
  if (record) observations.push({ label, status: response.status, wallMs, data: summary(data) });
  return { status: response.status, data, wallMs };
}
let service = await launch();
try {
  const health = aiServiceHealthSchema.parse((await call("initial_health", "/v1/health")).data);
  assert.equal(health.modelId, manifest.modelId);
  async function make(
    kind: "cpu" | "analysis",
    restricted = false,
    owner = "a".repeat(64),
    milliseconds = kind === "cpu" ? 500 : 30000,
  ) {
    const position = {
      schemaVersion: 1 as const,
      ruleProfileId: "tetraboard-four-shogi-singles-v1" as const,
      rulesVersion: 1 as const,
      initial: {
        mode: "singles" as const,
        players: { south: "south", west: "west", north: "north", east: "east" },
        threePlayerAttackProhibited: restricted,
      },
      events: [],
      eventOffset: 0,
    };
    const restored = await restoreAnalysisPosition(position);
    return aiJobRequestSchema.parse({
      schemaVersion: 1,
      serviceInstanceId: health.serviceInstanceId,
      requestId: createAiRequestId(health.requestWindow),
      principal: owner,
      codeVersion,
      engineVersion: health.engineVersion,
      modelId: manifest.modelId,
      stateHash: restored.stateHash,
      context:
        kind === "cpu"
          ? {
              kind,
              roomId: "trial",
              instanceId: crypto.randomUUID(),
              matchId: crypto.randomUUID(),
              revision: 1,
              side: "south",
              deadlineAtMs: Date.now() + 5000,
            }
          : { kind, matchId: crypto.randomUUID(), eventOffset: 0 },
      lifetimeMs: kind === "cpu" ? 5000 : 45000,
      budget: { timeBudgetMs: milliseconds, maxWork: kind === "cpu" ? 32768 : 1000000 },
      position,
    });
  }
  async function submit(label: string, request: AiJobRequest) {
    const response = await call(label, "/v1/jobs", "POST", request);
    assert.equal(response.status, 202);
    const job = aiJobSnapshotSchema.parse(response.data);
    assert.equal(job.inputHash, await aiRequestFingerprint(request));
    return job;
  }
  async function finish(
    label: string,
    jobId: string,
    request: AiJobRequest,
    expected = "completed",
  ) {
    const started = performance.now();
    while (performance.now() - started < 36000) {
      const response = await call(
        label,
        "/v1/jobs/" + jobId,
        "GET",
        undefined,
        request.principal,
        request.serviceInstanceId,
        false,
      );
      assert.equal(response.status, 200);
      const job = aiJobSnapshotSchema.parse(response.data);
      if (!["queued", "running"].includes(job.status)) {
        observations.push({
          label,
          status: response.status,
          wallMs: response.wallMs,
          pollElapsedMs: performance.now() - started,
          data: summary(job),
        });
        assert.equal(job.status, expected);
        if (expected === "completed") {
          const result = job.result as AiResult;
          assert.equal(result.model.usedModelId, manifest.modelId);
          assert(result.model.inferenceCount > 0);
          assert.equal(result.input.stateHash, request.stateHash);
        }
        return job;
      }
      await Bun.sleep(25);
    }
    throw new Error("job_completion_timeout");
  }
  assert.equal(
    (
      await call(
        "unauthenticated",
        "/v1/health",
        "GET",
        undefined,
        undefined,
        undefined,
        true,
        "wrong",
      )
    ).status,
    401,
  );
  assert.equal(
    (await call("invalid_input", "/v1/jobs", "POST", { command: "not-accepted" })).status,
    400,
  );
  assert.equal((await call("oversize", "/v1/jobs", "POST", "x".repeat(524288))).status, 413);
  const cpu = await make("cpu");
  const singleCpu = await submit("single_cpu_accept", cpu);
  await finish("single_cpu_complete", singleCpu.jobId, cpu);
  const long = await make("analysis");
  const singleLong = await submit("single_analysis_accept", long);
  await finish("single_analysis_complete", singleLong.jobId, long);
  const parallel = await make("analysis", true);
  const parallelJob = await submit("parallel_analysis_accept", parallel);
  const queued = await make("analysis", false, "b".repeat(64), 500);
  queued.lifetimeMs = 2000;
  const queuedJob = await submit("queued_accept", queued);
  const overflow = await make("analysis", false, "c".repeat(64), 500);
  assert.equal((await call("queue_overload", "/v1/jobs", "POST", overflow)).status, 503);
  const duplicate = await call("duplicate", "/v1/jobs", "POST", parallel);
  assert.equal(aiJobSnapshotSchema.parse(duplicate.data).jobId, parallelJob.jobId);
  assert.equal(
    (
      await call("conflicting_duplicate", "/v1/jobs", "POST", {
        ...parallel,
        budget: { ...parallel.budget, timeBudgetMs: 500 },
      })
    ).status,
    409,
  );
  assert.equal(
    (await call("usage_limit", "/v1/jobs", "POST", await make("analysis", true))).status,
    429,
  );
  const simultaneousCpu = await make("cpu", true, "d".repeat(64));
  const cpuJob = await submit("parallel_cpu_accept", simultaneousCpu);
  await finish("parallel_cpu_complete", cpuJob.jobId, simultaneousCpu);
  const stillRunning = await call(
    "analysis_during_cpu",
    "/v1/jobs/" + parallelJob.jobId,
    "GET",
    undefined,
    parallel.principal,
    parallel.serviceInstanceId,
  );
  assert.equal(aiJobSnapshotSchema.parse(stillRunning.data).status, "running");
  await finish("queued_expiry", queuedJob.jobId, queued, "expired");
  const cancelQueue = await make("analysis", false, "e".repeat(64), 500);
  const cancelQueuedJob = await submit("cancel_queue_accept", cancelQueue);
  assert.equal(
    (
      await call(
        "cancel_queued",
        "/v1/jobs/" + cancelQueuedJob.jobId,
        "DELETE",
        undefined,
        cancelQueue.principal,
        cancelQueue.serviceInstanceId,
      )
    ).status,
    200,
  );
  const cancelCpu = await make("cpu", false, "f".repeat(64));
  const cancelCpuJob = await submit("cancel_running_accept", cancelCpu);
  const cancelled = await call(
    "cancel_running",
    "/v1/jobs/" + cancelCpuJob.jobId,
    "DELETE",
    undefined,
    cancelCpu.principal,
    cancelCpu.serviceInstanceId,
  );
  assert.equal(aiJobSnapshotSchema.parse(cancelled.data).status, "cancelled");
  assert.equal(
    aiJobSnapshotSchema.parse((await call("cancelled_retry", "/v1/jobs", "POST", cancelCpu)).data)
      .status,
    "cancelled",
  );
  const wrong = await make("cpu", false, "0".repeat(64));
  wrong.stateHash = "0".repeat(64);
  const bad = await submit("state_mismatch_accept", wrong);
  const rejected = await finish("state_mismatch", bad.jobId, wrong, "failed");
  assert.equal(rejected.error, "state_mismatch");
  assert.equal(
    (
      await call(
        "foreign_owner",
        "/v1/jobs/" + parallelJob.jobId,
        "GET",
        undefined,
        "0".repeat(64),
        parallel.serviceInstanceId,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call("model_mismatch", "/v1/jobs", "POST", {
        ...overflow,
        modelId: "four-shogi-tiny-policy-value-v1:" + "f".repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("expired_request", "/v1/jobs", "POST", {
        ...overflow,
        requestId: createAiRequestId(health.requestWindow),
        lifetimeMs: 0,
      })
    ).status,
    410,
  );
  for (let i = 0; i < 10; i++) {
    assert.equal((await call("health_during_analysis", "/v1/health")).status, 200);
    await Bun.sleep(20);
  }
  await finish("parallel_analysis_complete", parallelJob.jobId, parallel);
  const stoppingJob = await make("analysis", false, "1".repeat(64));
  await submit("shutdown_active_accept", stoppingJob);
  const stop = performance.now();
  assert.equal((await call("shutdown_active", "/v1/shutdown", "POST")).status, 202);
  service.phase.exitCode = await timeout(service.exited, 5000);
  service.phase.stopMs = performance.now() - stop;
  assert.equal(service.phase.exitCode, 0);
  await verifyStopped(service.phase);
  assert.equal(service.stderr(), 0);
  service = await launch();
  const restarted = aiServiceHealthSchema.parse((await call("restart_health", "/v1/health")).data);
  assert.notEqual(restarted.serviceInstanceId, health.serviceInstanceId);
  assert.equal((await call("old_instance_submit", "/v1/jobs", "POST", parallel)).status, 410);
  assert.equal(
    (
      await call(
        "old_instance_lookup",
        "/v1/jobs/" + parallelJob.jobId,
        "GET",
        undefined,
        parallel.principal,
        health.serviceInstanceId,
      )
    ).status,
    410,
  );
  const initialWorker = service.phase.logs.find((v) => {
    const e = v as { event?: string; slot?: number };
    return e.event === "compute_ready" && e.slot === 0;
  }) as { modelPid: number };
  const recoveryStarted = performance.now();
  process.kill(initialWorker.modelPid, "SIGKILL");
  const replacements = () =>
    service.phase.logs.filter((v) => {
      const e = v as { event?: string; slot?: number };
      return e.event === "compute_ready" && e.slot === 0;
    });
  let unavailableResponses = 0;
  while (replacements().length < 2 && performance.now() - recoveryStarted < 15000) {
    const response = await call(
      "model_failure_health",
      "/v1/health",
      "GET",
      undefined,
      undefined,
      undefined,
      false,
    );
    if (response.status === 503) unavailableResponses++;
    await Bun.sleep(10);
  }
  assert.equal(replacements().length, 2);
  observations.push({
    label: "model_failure_recovery",
    wallMs: performance.now() - recoveryStarted,
    unavailableResponses,
  });
  assert.equal((await call("recovered_health", "/v1/health")).status, 200);
  const recoveredRequest = {
    ...(await make("cpu", true, "2".repeat(64))),
    serviceInstanceId: restarted.serviceInstanceId,
    requestId: createAiRequestId(restarted.requestWindow),
  };
  const recoveredJob = await submit("recovered_cpu_accept", recoveredRequest);
  await finish("recovered_cpu_complete", recoveredJob.jobId, recoveredRequest);
  const stopAgain = performance.now();
  await call("restart_shutdown", "/v1/shutdown", "POST");
  service.phase.exitCode = await timeout(service.exited, 5000);
  service.phase.stopMs = performance.now() - stopAgain;
  assert.equal(service.phase.exitCode, 0);
  await verifyStopped(service.phase);
  assert.equal(service.stderr(), 0);
  assert(!JSON.stringify({ phases, observations }).includes(secret));
  const report = {
    format: "four-shogi-ai-service-smoke-v1",
    codeVersion,
    model: {
      modelId: manifest.modelId,
      artifactSha256: manifest.weights.sha256,
      codeHash: manifest.codeHash,
    },
    environment: { bun: Bun.version, platform: process.platform, arch: process.arch },
    trialOverrides: { maxQueueAnalysis: 1, analysisRequests: 2 },
    recordScope:
      "Job summaries include common AI identities, model usage, evaluations and timing; per-candidate/PV output and authentication headers are omitted. Loopback HTTP, not public HTTPS or an actual VPS.",
    complete: true,
    phases,
    observations,
  };
  writeFileSync(args.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify({ complete: true, observations: observations.length, output: args.output }),
  );
} catch (error) {
  assert(!JSON.stringify({ phases, observations }).includes(secret));
  writeFileSync(
    args.output + ".failed.json",
    JSON.stringify({ complete: false, codeVersion, phases, observations }, null, 2) + "\n",
    { flag: "wx" },
  );
  throw error;
} finally {
  if (service.child.exitCode === null) {
    service.child.kill("SIGTERM");
    await timeout(service.exited, 5000).catch(() => service.child.kill("SIGKILL"));
  }
}
