import { useEffect, useRef, useState } from "react";
import type { ReplayFourShogiMatch } from "@tetraboard/protocol";
import {
  aiJobSnapshotSchema,
  aiServiceHealthSchema,
  createAiRequestId,
  type AiJobSnapshot,
} from "@tetraboard/protocol/four-shogi-ai";
import { accountRequestGeneration, isCurrentAccountRequest } from "../account/accountRequestScope";
import {
  replayAnalysisRoot,
  readReplayAnalysis,
  type AnalysisProfile,
  type ReplayAnalysis,
} from "./fourShogiAnalysis";
import type { FourShogiReplayFrame } from "./fourShogiReplayV1";

class AnalysisError extends Error {}
async function json(path: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`/api/four-shogi-ai${path}`, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const wait = Math.min(600, Math.max(1, Number(response.headers.get("Retry-After")) || 60));
      throw new AnalysisError(
        response.status === 401
          ? "ログイン状態を確認してから、もう一度お試しください。"
          : response.status === 403
            ? "このアカウント・環境では解析の試用を利用できません。"
            : response.status === 429
              ? `解析の使用量または待ち行列の上限です。${wait}秒後を目安に再試行してください。`
              : [409, 410].includes(response.status)
                ? "解析サービスが更新されたか、要求の期限が切れました。再試行してください。"
                : "解析サービスを利用できません。時間をおいて再試行してください。",
      );
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
function jobPath(job: AiJobSnapshot) {
  return `/jobs/${job.jobId}?serviceInstanceId=${job.serviceInstanceId}`;
}
function cancelJob(job: AiJobSnapshot) {
  if (["queued", "running"].includes(job.status))
    void json(jobPath(job), { method: "DELETE" }).catch(() => {});
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 750);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
type State = {
  phase: "idle" | "preparing" | "queued" | "running" | "completed" | "cancelled" | "error";
  error?: string;
  analysis?: ReplayAnalysis;
  profile?: AnalysisProfile;
  codeVersion?: string;
  modelId?: string | null;
};
export function useReplayAnalysis(
  match: ReplayFourShogiMatch,
  frames: readonly FourShogiReplayFrame[],
  index: number,
) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const active = useRef<{
    controller: AbortController;
    job?: AiJobSnapshot;
    stopped: boolean;
  } | null>(null);
  const stop = () => {
    const run = active.current;
    if (run) {
      run.stopped = true;
      run.controller.abort();
      if (run.job) cancelJob(run.job);
      active.current = null;
    }
  };
  useEffect(
    () => () => {
      const run = active.current;
      if (run) {
        run.stopped = true;
        run.controller.abort();
        if (run.job) cancelJob(run.job);
      }
    },
    [],
  );
  const start = async (profile: AnalysisProfile) => {
    if (active.current) return;
    const run = {
      controller: new AbortController(),
      stopped: false,
      job: undefined as AiJobSnapshot | undefined,
    };
    active.current = run;
    const generation = accountRequestGeneration();
    const current = () =>
      !run.stopped && active.current === run && isCurrentAccountRequest(generation);
    const started = performance.now();
    setState({ phase: "preparing", profile });
    try {
      const root = await replayAnalysisRoot(match, frames, index);
      if (!current()) return;
      const health = aiServiceHealthSchema.parse(
        await json("/health", { signal: run.controller.signal }),
      );
      if (health.status !== "ready" || !health.modelId)
        throw new AnalysisError("解析サービスのモデルを確認できません。再試行してください。");
      if (!current()) return;
      const requestId = createAiRequestId(health.requestWindow);
      const accept = (value: unknown) => {
        const job = aiJobSnapshotSchema.parse(value);
        if (
          job.serviceInstanceId !== health.serviceInstanceId ||
          job.requestId !== requestId ||
          job.stateHash !== root.position.stateHash ||
          job.codeVersion !== health.codeVersion ||
          job.modelId !== health.modelId ||
          job.context.kind !== "analysis" ||
          job.context.matchId !== match.id ||
          job.context.eventOffset !== index ||
          (run.job && (job.jobId !== run.job.jobId || job.inputHash !== run.job.inputHash))
        )
          throw new Error("job_mismatch");
        run.job = job;
        if (!current()) {
          cancelJob(job);
          return false;
        }
        if (job.status === "completed") {
          const analysis = readReplayAnalysis(job.result, root, { ...health, profile });
          if (current())
            setState({
              phase: "completed",
              analysis,
              profile,
              codeVersion: health.codeVersion,
              modelId: health.modelId,
            });
          return false;
        }
        if (!["queued", "running"].includes(job.status))
          throw new AnalysisError(
            job.status === "cancelled"
              ? "解析は取り消されました。"
              : job.status === "expired"
                ? "解析の期限が切れました。再試行してください。"
                : "解析を完了できませんでした。計算予算内の評価やモデルを取得できなかった可能性があります。再試行してください。",
          );
        setState({ phase: job.status as "queued" | "running", profile });
        return true;
      };
      // 受付中の取消でも、遅れて判明したjobIdへ取消を送れるようPOST応答を受け取ります。
      let pending = accept(
        await json("/jobs", {
          method: "POST",
          body: JSON.stringify({
            schemaVersion: 1,
            serviceInstanceId: health.serviceInstanceId,
            requestId,
            matchId: match.id,
            eventOffset: index,
            stateHash: root.position.stateHash,
            profile,
          }),
        }),
      );
      while (pending && current()) {
        if (performance.now() - started > 50000)
          throw new AnalysisError("解析の応答期限を過ぎました。再試行してください。");
        await pause(run.controller.signal);
        if (!current()) break;
        pending = accept(await json(jobPath(run.job!), { signal: run.controller.signal }));
      }
    } catch (error) {
      if (run.job) cancelJob(run.job);
      if (current())
        setState({
          phase: "error",
          profile,
          error:
            error instanceof AnalysisError
              ? error.message
              : "解析結果の局面・版・読み筋を確認できませんでした。再試行してください。",
        });
    } finally {
      if (active.current === run) active.current = null;
    }
  };
  return {
    ...state,
    start,
    cancel: () => {
      stop();
      setState({ phase: "cancelled" });
    },
    busy: ["preparing", "queued", "running"].includes(state.phase),
  };
}
