import { expect, test } from "bun:test";
import { JobManager, type Computed, type JobExecutor } from "../src/jobs";
import { type ServiceConfig } from "../src/config";
import { type AiJobRequest } from "@tetraboard/protocol/four-shogi-ai";

import { uuid, config, request } from "./fixtures";
class ControlledExecutor implements JobExecutor {
  calls: {
    slot: number;
    jobId: string;
    request: AiJobRequest;
    done: (r: Computed | null, error?: string) => void;
  }[] = [];
  cancellations: string[] = [];
  kills: number[] = [];
  ready() {
    return true;
  }
  run(
    slot: number,
    jobId: string,
    request: AiJobRequest,
    _budget: number,
    done: (r: Computed | null, error?: string) => void,
  ) {
    this.calls.push({ slot, jobId, request, done });
  }
  cancel(_slot: number, jobId: string) {
    this.cancellations.push(jobId);
  }
  kill(slot: number) {
    this.kills.push(slot);
  }
  async close() {}
}
function setup(overrides: Partial<ServiceConfig> = {}) {
  let now = 0,
    next = 100;
  const executor = new ControlledExecutor();
  const manager = new JobManager(
    { ...config, ...overrides },
    executor,
    uuid(99),
    () => now,
    () => uuid(++next),
  );
  return {
    manager,
    executor,
    advance: (ms: number) => {
      now += ms;
      manager.tick();
    },
  };
}
test("長時間解析でCPU予約枠を塞がず、CPUを優先して待ち行列を進める", () => {
  const { manager, executor } = setup({ maxPendingPerPrincipal: 5 });
  manager.submit(request(), "1");
  manager.submit(request(2), "2");
  manager.submit(request(3, "cpu"), "3");
  expect(executor.calls.map((c) => [c.slot, c.request.context.kind])).toEqual([
    [1, "analysis"],
    [0, "cpu"],
  ]);
});
test("同じ要求は再計算・二重課金せず、内容違いのID再利用を拒否する", () => {
  const { manager, executor } = setup({ analysisRequests: 1 });
  const first = manager.submit(request(), "same");
  expect(manager.submit(request(), "same").jobId).toBe(first.jobId);
  expect(executor.calls).toHaveLength(1);
  expect(() => manager.submit(request(), "different")).toThrow("request_conflict");
  expect(() => manager.submit(request(2), "second")).toThrow("usage_limit");
});
test("取消後の遅い結果を採用せず、取消済みの再送でも復活しない", () => {
  const { manager, executor } = setup();
  const input = request();
  const job = manager.submit(input, "same");
  expect(manager.cancel(job.jobId, input.principal, input.serviceInstanceId).status).toBe(
    "cancelled",
  );
  executor.calls[0].done({ result: { late: true }, restoreMs: 0, searchMs: 1, inferenceMs: 0 });
  expect(manager.submit(input, "same")).toMatchObject({ status: "cancelled", result: null });
});
test("計算枠と待ち行列・保存件数・利用予算を有限にし、他人の結果を隠す", () => {
  const { manager } = setup({ maxQueueAnalysis: 1, maxPendingPerPrincipal: 5 });
  const input = request();
  const first = manager.submit(input, "1");
  manager.submit(request(2), "2");
  expect(() => manager.submit(request(3), "3")).toThrow("queue_full");
  expect(() => manager.get(first.jobId, "d".repeat(64), input.serviceInstanceId)).toThrow(
    "job_not_found",
  );
});
test("待ち・実行期限と強制停止を単調時計で処理し、旧起動への要求を拒否する", () => {
  const { manager, executor, advance } = setup({ maxPendingPerPrincipal: 5 });
  const one = request(),
    two = request(2);
  two.lifetimeMs = 100;
  manager.submit(one, "1");
  const job = manager.submit(two, "2");
  advance(101);
  expect(manager.get(job.jobId, two.principal, two.serviceInstanceId).status).toBe("expired");
  expect(() => manager.submit({ ...one, serviceInstanceId: uuid(98) }, "old")).toThrow(
    "service_restarted",
  );
  advance(60000);
  advance(config.cancelGraceMs + 1);
  expect(executor.kills).toContain(1);
});
test("容量・予算・モデル/コード差・期限0を拒否し、使用量は満了後だけ戻す", () => {
  const { manager, advance } = setup({ analysisBudgetMs: 30000, maxJobs: 3 });
  expect(() => manager.submit({ ...request(), codeVersion: "d".repeat(40) }, "bad")).toThrow(
    "code_mismatch",
  );
  expect(() =>
    manager.submit(
      { ...request(), modelId: "four-shogi-tiny-policy-value-v1:" + "d".repeat(64) },
      "bad",
    ),
  ).toThrow("model_mismatch");
  expect(() => manager.submit({ ...request(), lifetimeMs: 0 }, "old")).toThrow("expired");
  const first = manager.submit(request(), "1");
  manager.cancel(first.jobId, request().principal, request().serviceInstanceId);
  expect(() => manager.submit(request(2), "2")).toThrow("usage_limit");
  advance(config.quotaWindowMs + 1);
  expect(
    manager.submit(
      { ...request(2), requestId: `${Math.floor((config.quotaWindowMs + 1) / 60000)}:${uuid(2)}` },
      "2",
    ).status,
  ).toBe("running");
});
test("強制停止後の遅い応答を無視し、メモリ上限では新規受付も止める", () => {
  const { manager, executor, advance } = setup();
  const input = request();
  const job = manager.submit(input, "1");
  manager.cancel(job.jobId, input.principal, input.serviceInstanceId);
  advance(config.cancelGraceMs + 1);
  const other = manager.submit(request(2), "2");
  executor.calls[0].done({ result: { old: true }, restoreMs: 0, searchMs: 0, inferenceMs: 0 });
  expect(manager.get(other.jobId, input.principal, input.serviceInstanceId).status).toBe("running");
  manager.resourceLimit();
  expect(manager.health().status).toBe("unavailable");
  expect(() => manager.submit(request(3), "3")).toThrow("unavailable");
});
test("完了結果と重複識別をTTLまで保持し、容量超過で既存要求を追い出さない", () => {
  const { manager, executor, advance } = setup({ maxJobs: 1 });
  const first = manager.submit(request(), "1");
  executor.calls[0].done({ result: { observed: true }, restoreMs: 1, searchMs: 2, inferenceMs: 3 });
  expect(manager.submit(request(), "1")).toMatchObject({
    jobId: first.jobId,
    status: "completed",
    result: { observed: true },
  });
  expect(() => manager.submit(request(2), "2")).toThrow("job_capacity");
  advance(config.resultTtlMs + 1);
  expect(() => manager.get(first.jobId, request().principal, request().serviceInstanceId)).toThrow(
    "job_not_found",
  );
  expect(() => manager.submit(request(), "1")).toThrow("request_expired");
  expect(
    manager.submit(
      { ...request(2), requestId: `${Math.floor((config.resultTtlMs + 1) / 60000)}:${uuid(2)}` },
      "2",
    ).status,
  ).toBe("running");
});
test("利用者辞書にも上限を設け、窓の満了前に別利用者で無制限に増やせない", () => {
  const { manager } = setup({ maxPrincipals: 1 });
  manager.submit(request(), "1");
  expect(() => manager.submit({ ...request(2), principal: "d".repeat(64) }, "2")).toThrow(
    "principal_limit",
  );
  expect(() =>
    manager.submit({ ...request(3, "cpu"), budget: { timeBudgetMs: 501, maxWork: 100 } }, "3"),
  ).toThrow("budget_limit");
});
