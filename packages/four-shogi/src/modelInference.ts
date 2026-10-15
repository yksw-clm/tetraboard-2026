import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getAnalysisLegalActions, type AnalysisPosition } from "./analysis";
import { encodeAction, actionEncodingVersion } from "./actionEncoding";
import { encodeModelFeatures, featureVersion } from "./modelFeatures";
import { sides } from "./types";

export const inferenceProtocol = "four-shogi-inference-ipc-v1";
const maxFrameBytes = 16 * 1024 ** 2;
const versions = {
  modelVersion: "four-shogi-tiny-policy-value-v1",
  featureVersion,
  actionEncodingVersion,
  ruleProfileId: "tetraboard-four-shogi-singles-v1",
  rulesVersion: 1,
  valueOrder: [...sides, "noSoleWinner"],
};
export type ModelHealth = {
  modelId: string;
  calibrated: false;
  supportedRestrictions: boolean[];
  codeHash: string;
  valueOrder: string[];
  runtime: { python: string; torch: string; device: string };
  startupCandidateFailure?: string;
};
export type ModelOutput = {
  id: string;
  legalActionIds: number[];
  policyLogits: number[];
  policy: number[];
  topActionId: number;
  value: number[];
  illegalPolicyNonzero: 0;
};
export class ModelInferenceError extends Error {
  constructor(
    message: string,
    readonly fallback: "static" | "retain-active" = "static",
    readonly activeModelId: string | null = null,
  ) {
    super(message);
  }
}
function inputRows(positions: readonly AnalysisPosition[]) {
  if (!positions.length || positions.length > 16) throw new RangeError("推論batchは1〜16局面です");
  return positions.map((position, index) => ({
    id: String(index),
    restricted: position.state.threePlayerAttackProhibited,
    features: encodeModelFeatures(position),
    legalActionIds: getAnalysisLegalActions(position)
      .map(encodeAction)
      .sort((a, b) => a - b),
  }));
}
function health(value: unknown): ModelHealth {
  const result = value as ModelHealth;
  if (
    !result ||
    !/^four-shogi-tiny-policy-value-v1:[0-9a-f]{64}$/.test(result.modelId) ||
    result.calibrated !== false ||
    !/^[0-9a-f]{64}$/.test(result.codeHash) ||
    !Array.isArray(result.supportedRestrictions) ||
    !result.supportedRestrictions.length ||
    result.supportedRestrictions.some((flag) => typeof flag !== "boolean") ||
    JSON.stringify(result.valueOrder) !== JSON.stringify(versions.valueOrder) ||
    result.runtime?.python !== "3.12" ||
    result.runtime?.torch !== "2.14.1" ||
    result.runtime?.device !== "cpu"
  )
    throw new ModelInferenceError("推論プロセスの健全性応答が不正です");
  return result;
}

/** 同一ホストの常駐プロセスへまとめて依頼します。期限超過時は終了し、呼出側へfallback理由を返します。 */
export class ModelInferenceClient {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private failure: Error | null = null;
  private active: ModelHealth | null = null;
  private constructor(
    command: readonly string[],
    private timeoutMs: number,
  ) {
    if (!command.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new RangeError("推論起動commandと1〜60000msの期限が必要です");
    this.process = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", () => this.fail(new ModelInferenceError("推論プロセスが終了しました")));
    this.process.stdin.on("error", (error) => this.fail(error));
    // stderrを溜め込まず排出します。失敗理由は版付き応答で返します。
    this.process.stderr.resume();
    this.process.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
  }
  static async start(
    command: readonly string[],
    options: { timeoutMs?: number; startupMs?: number } = {},
  ) {
    const client = new ModelInferenceClient(command, options.timeoutMs ?? 5000);
    try {
      const ready = await client.wait(0, options.startupMs ?? 30_000);
      client.active = health(ready);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  get loadedModel(): ModelHealth {
    if (!this.active || this.failure)
      throw this.failure ?? new ModelInferenceError("モデル未起動です");
    return structuredClone(this.active);
  }
  private wait(id: number, timeoutMs: number) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      return Promise.reject(new RangeError("期限は1〜60000msです"));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new ModelInferenceError("モデル推論の期限を超えました")),
        timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index: number;
    while ((index = this.buffer.indexOf(10)) >= 0) {
      if (index > maxFrameBytes)
        return this.fail(new ModelInferenceError("推論応答の容量上限です"));
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      try {
        const message = JSON.parse(line.toString("utf8"));
        const waiting = this.pending.get(message.id);
        if (message.protocol !== inferenceProtocol || !waiting || typeof message.ok !== "boolean")
          throw new ModelInferenceError("推論応答の版/要求IDが不一致です");
        clearTimeout(waiting.timer);
        this.pending.delete(message.id);
        if (message.ok)
          waiting.resolve(
            message.id === 0 && message.candidateFailure
              ? { ...message.result, startupCandidateFailure: String(message.candidateFailure) }
              : message.result,
          );
        else
          waiting.reject(
            new ModelInferenceError(String(message.error), message.fallback, message.activeModelId),
          );
      } catch (error) {
        return this.fail(
          error instanceof Error ? error : new ModelInferenceError("推論応答が不正です"),
        );
      }
    }
    if (this.buffer.length > maxFrameBytes)
      this.fail(new ModelInferenceError("推論応答の容量上限です"));
  }
  private request(body: object) {
    if (this.pending.size >= 16)
      return Promise.reject(new ModelInferenceError("推論待ちの上限です"));
    const id = this.nextId++;
    const frame = JSON.stringify({ ...body, protocol: inferenceProtocol, id }) + "\n";
    if (Buffer.byteLength(frame) > maxFrameBytes)
      return Promise.reject(new ModelInferenceError("推論要求の容量上限です"));
    const result = this.wait(id, this.timeoutMs);
    if (!this.failure) this.process.stdin.write(frame);
    return result;
  }
  async activate(directory: string, probe: readonly AnalysisPosition[]) {
    this.active = health(
      await this.request({ op: "activate", directory, probe: inputRows(probe) }),
    );
    return this.loadedModel;
  }
  async evaluate(positions: readonly AnalysisPosition[]): Promise<ModelOutput[]> {
    const rows = inputRows(positions);
    const modelId = this.loadedModel.modelId;
    const response = (await this.request({ op: "evaluate", ...versions, modelId, rows })) as {
      modelId: string;
      rows: ModelOutput[];
    };
    try {
      if (response.modelId !== modelId || response.rows.length !== rows.length)
        throw new Error("モデルID/件数が不一致です");
      response.rows.forEach((output, i) => {
        const ids = rows[i].legalActionIds;
        if (
          output.id !== rows[i].id ||
          JSON.stringify(output.legalActionIds) !== JSON.stringify(ids) ||
          output.policy.length !== ids.length ||
          output.policyLogits.length !== ids.length ||
          output.value.length !== 5 ||
          output.illegalPolicyNonzero !== 0
        )
          throw new Error("合法手ID/席/次元が不一致です");
        for (const scores of [output.policy, output.value]) {
          if (
            scores.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
            Math.abs(scores.reduce((a, b) => a + b, 0) - 1) > 1e-5
          )
            throw new Error("Policy/Valueの数値が不正です");
        }
        if (output.policyLogits.some((v) => !Number.isFinite(v)))
          throw new Error("logitが不正です");
        const top = output.policyLogits.indexOf(Math.max(...output.policyLogits));
        if (ids[top] !== output.topActionId) throw new Error("最良行動IDが不一致です");
        sides.forEach((side, index) => {
          if (
            positions[i].state.eliminations.some((entry) => entry.side === side) &&
            output.value[index] !== 0
          )
            throw new Error("脱落した席のValueが不正です");
        });
      });
      return response.rows;
    } catch (error) {
      const failure = new ModelInferenceError(`推論結果の整合検査に失敗しました: ${String(error)}`);
      this.fail(failure);
      throw failure;
    }
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.process.kill("SIGKILL");
  }
  close() {
    this.fail(new ModelInferenceError("推論クライアントを終了しました"));
  }
}
