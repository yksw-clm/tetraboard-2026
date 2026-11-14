import { availableParallelism } from "node:os";
import { readWorkspaces } from "./repository";
import { runTask, runTasks, type Task } from "./tasks";

const workspaces = readWorkspaces().filter((path) => path !== "packages/ai");
const mode = process.argv[2];
const serial = process.argv.includes("--serial");
if (!["test", "check", "build"].includes(mode))
  throw new Error("test/check/buildを指定してください");
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
  await runTask({ name: "CI runner tests", command: ["bun", "test", "./scripts/ci/test"] });
  await runTask({
    name: "CI runner types",
    command: ["bun", "check", "--no-script", "--all", "-p", "scripts/ci/tsconfig.json"],
  });
  // Bunの型検査は内部でCPUを並列利用するため、workspace間では直列にします。
  for (const path of workspaces)
    await runTask({ name: `typecheck ${path}`, command: command(path, "typecheck") });
}

if (mode === "test" || mode === "check") {
  if (mode === "test")
    await runTask({ name: "CI runner tests", command: ["bun", "test", "./scripts/ci/test"] });
  const tasks: Task[] = [];
  if (workspaces.includes("apps/worker")) {
    const groups = serial ? [[]] : [["--shard=1/2"], ["--shard=2/2"]];
    for (const [index, group] of groups.entries())
      tasks.push({
        name: `Worker ${index + 1}-${groups.length}`,
        command: command("apps/worker", "test", group),
      });
  }
  const priority = ["packages/four-shogi", "apps/web"];
  for (const path of workspaces
    .filter((path) => path !== "apps/worker")
    .sort(
      (a, b) =>
        (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) -
        (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)),
    ))
    tasks.push({ name: `test ${path}`, command: command(path, "test") });
  await runTasks(tasks, serial ? 1 : Math.min(availableParallelism(), 4));
}

if (mode === "build") {
  for (const path of ["apps/web", "apps/admin"])
    if (workspaces.includes(path))
      await runTask({ name: `build ${path}`, command: command(path, "build:assets") });
}
