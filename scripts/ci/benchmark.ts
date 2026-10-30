import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectPlan } from "./impact";
import { git, readWorkspaces, root } from "./repository";
import { runTask } from "./tasks";

const base = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("比較するbase SHAを指定してください");
const directory = mkdtempSync(join(tmpdir(), "tetraboard-ci-benchmark-"));
const baseline = join(directory, "baseline");
const planPath = join(root, ".ci-plan.json");
const previous = existsSync(planPath) ? readFileSync(planPath) : null;
const measurements: { name: string; seconds: number }[] = [];
const measure = async (name: string, work: () => Promise<void>) => {
  const started = performance.now();
  await work();
  measurements.push({ name, seconds: (performance.now() - started) / 1000 });
};
try {
  // 同じrunner・Bun・Nodeで順番に比較します。別checkoutなので設定・資産を共有しません。
  git(["clone", "--shared", "--no-checkout", root, baseline]);
  git(["checkout", "--detach", base], baseline);
  await runTask({
    name: "baseline install",
    cwd: baseline,
    command: ["bun", "install", "--frozen-lockfile"],
  });
  for (const round of [1, 2]) {
    for (const [name, cwd] of [
      ["before", baseline],
      ["after", root],
    ]) {
      await measure(`${name}-check-${round}`, async () => {
        await runTask({ name: `${name}-check-${round}`, cwd, command: ["bun", "run", "check"] });
      });
    }
  }
  await runTask({
    name: "Worker storage isolation",
    command: ["bun", "scripts/ci/verifyWorkerIsolation.ts"],
  });
  const workspaces = readWorkspaces();
  for (const [name, file] of [
    ["web", "apps/web/src/app/router.tsx"],
    ["admin", "apps/admin/src/App.tsx"],
    ["study", "apps/four-shogi-study/src/search/runtime.ts"],
  ]) {
    const plan = selectPlan([file], workspaces);
    if (plan.mode !== "fast") throw new Error(`${name} がFastになりませんでした`);
    writeFileSync(planPath, JSON.stringify(plan));
    await measure(`fast-${name}`, async () => {
      await runTask({ name: `fast-${name}-check`, command: ["bun", "scripts/ci/run.ts", "check"] });
      await runTask({ name: `fast-${name}-build`, command: ["bun", "scripts/ci/run.ts", "build"] });
    });
  }
  const report = { base, head: git(["rev-parse", "HEAD"]).trim(), bun: Bun.version, measurements };
  writeFileSync(join(root, ".ci-benchmark.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## 同じrunnerでの比較\n\nBase: ${base}\n\nHead: ${report.head}\n\n| 検証 | 秒 |\n| --- | ---: |\n${measurements.map((m) => `| ${m.name} | ${m.seconds.toFixed(2)} |`).join("\n")}\n\nFast値は選択・check・buildの実処理のみです。runner割当・checkout・installを含めません。\n`,
    );
} finally {
  if (previous) writeFileSync(planPath, previous);
  else rmSync(planPath, { force: true });
  rmSync(directory, { recursive: true, force: true });
}
