import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fullReason, selectPlan } from "./impact";
import { changedFiles, git, readWorkspaces } from "./repository";

const event = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
  : {};
const workspaces = readWorkspaces();
let reason = fullReason(
  process.env.GITHUB_EVENT_NAME,
  event.pull_request?.base?.ref,
  event.pull_request?.labels?.map((label: { name: string }) => label.name),
);
let files: string[] = [];
try {
  if (!reason) files = changedFiles(event.pull_request?.base?.sha);
} catch (error) {
  reason = `差分を確定できないためFull CIへ移行します: ${String(error)}`;
}
const plan = {
  ...selectPlan(files, workspaces, reason),
  files,
  commit: git(["rev-parse", "HEAD"]).trim(),
};
writeFileSync(".ci-plan.json", JSON.stringify(plan, null, 2));
console.log(JSON.stringify(plan, null, 2));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## ${plan.mode === "full" ? "Full" : "Fast"} CI\n\nCommit: \`${plan.commit}\`\n\n${plan.reasons.join("\n")}\n\n実行: ${plan.workspaces.join(", ") || "共通の静的検証のみ"}\n\n未実行: ${
      workspaces
        .filter((w) => !plan.workspaces.includes(w.path))
        .map((w) => w.path)
        .join(", ") || "なし"
    }\n\nFast成功は未実行の検証の成功を意味しません。デプロイはFull成功時のみ許可します。\n`,
  );
