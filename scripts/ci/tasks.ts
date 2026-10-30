import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./repository";

export interface Task {
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  record?: boolean;
}
export interface Result {
  name: string;
  seconds: number;
  exitCode: number;
}

export async function runTask(task: Task): Promise<Result> {
  mkdirSync(resolve(root, ".ci-logs"), { recursive: true });
  const log = resolve(root, ".ci-logs", `${task.name.replaceAll(/[^a-zA-Z0-9-]/g, "-")}.log`);
  console.log(`開始: ${task.name}`);
  const started = performance.now();
  const output = openSync(log, "w");
  let exitCode: number;
  try {
    const child = Bun.spawn(task.command, {
      cwd: task.cwd ?? root,
      env: { ...process.env, ...task.env },
      stdout: output,
      stderr: output,
    });
    exitCode = await child.exited;
  } finally {
    closeSync(output);
  }
  const result = { name: task.name, seconds: (performance.now() - started) / 1000, exitCode };
  console.log(`::group::${task.name} (${result.seconds.toFixed(2)}s, exit ${exitCode})`);
  console.log(await Bun.file(log).text());
  console.log("::endgroup::");
  if (task.record !== false)
    appendFileSync(resolve(root, ".ci-results.jsonl"), JSON.stringify(result) + "\n");
  if (task.record !== false && process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `- ${task.name}: ${result.seconds.toFixed(2)}秒、exit ${exitCode}\n`,
    );
  if (exitCode !== 0) throw new Error(`${task.name} が失敗しました (exit ${exitCode})`);
  return result;
}

export async function runTasks(tasks: Task[], concurrency = 2): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("不正な並列数です");
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (!failed && next < tasks.length) {
      const task = tasks[next++];
      try {
        await runTask(task);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  // 開始済みの検証を回収してから失敗を返し、子プロセスや出力を取り残しません。
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
