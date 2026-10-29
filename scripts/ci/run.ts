import { readFileSync, statSync } from "node:fs";
import type { Plan } from "./impact";
import { readWorkspaces, root } from "./repository";
import { runTask, runTasks, type Task } from "./tasks";
import { splitWorkerFiles, workerTestPattern } from "./workerGroups";

const workspaces = readWorkspaces();
const mode = process.argv[2];
const serial = process.argv.includes("--serial");
const plan: Plan =
  mode === "test"
    ? { mode: "full", workspaces: workspaces.map((w) => w.path), reasons: [] }
    : JSON.parse(readFileSync(".ci-plan.json", "utf8"));
if (!["test", "check", "build"].includes(mode))
  throw new Error("test/check/buildを指定してください");
if (plan.mode !== "fast" && plan.mode !== "full") throw new Error("不正なCI planです");
if (plan.workspaces.some((path) => !workspaces.some((w) => w.path === path)))
  throw new Error("未知のworkspaceです");
const command = (path: string, script: string, args: string[] = []): string[] => [
  "bun",
  "run",
  "--cwd",
  path,
  script,
  ...args,
];

if (mode === "check") {
  await runTask({ name: "format", command: ["bun", "run", "format:check"] });
  await runTask({ name: "lint", command: ["bun", "run", "lint"] });
  await runTask({ name: "CI policy tests", command: ["bun", "test", "./scripts/ci/test"] });
  await runTask({
    name: "CI policy types",
    command: ["bun", "check", "--no-script", "--all", "-p", "scripts/ci/tsconfig.json"],
  });
  // Bunの型検査は内部でCPUを並列利用するため、workspace間では直列にします。
  for (const path of plan.workspaces)
    await runTask({ name: `typecheck ${path}`, command: command(path, "typecheck") });
}

if (mode === "test" || mode === "check") {
  if (mode === "test")
    await runTask({ name: "CI policy tests", command: ["bun", "test", "./scripts/ci/test"] });
  const tasks: Task[] = [];
  if (plan.workspaces.includes("apps/worker")) {
    const files = [...new Bun.Glob(workerTestPattern).scanSync(`${root}/apps/worker`)];
    if (!files.length) throw new Error("Workerテストが見つかりません");
    const groups = serial
      ? [files.sort()]
      : splitWorkerFiles(
          files.map((path) => ({ path, size: statSync(`${root}/apps/worker/${path}`).size })),
        );
    for (const [index, group] of groups.entries())
      tasks.push({
        name: `Worker ${index + 1}-${groups.length}`,
        command: command("apps/worker", "test", group),
      });
  }
  const priority = ["packages/four-shogi", "apps/web", "apps/four-shogi-study"];
  for (const path of plan.workspaces
    .filter((path) => path !== "apps/worker")
    .sort(
      (a, b) =>
        (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) -
        (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)),
    ))
    tasks.push({ name: `test ${path}`, command: command(path, "test") });
  await runTasks(tasks, serial ? 1 : 2);
}

if (mode === "build") {
  for (const path of ["apps/web", "apps/admin", "apps/four-shogi-study"])
    if (plan.workspaces.includes(path))
      await runTask({ name: `build ${path}`, command: command(path, "build:assets") });
}
