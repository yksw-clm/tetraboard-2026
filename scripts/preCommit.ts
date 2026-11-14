import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const lintExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
]);

export function selectFiles(files: readonly string[], ignorePatterns: readonly string[]) {
  const ignores = ignorePatterns.map((pattern) => ({
    glob: new Bun.Glob(pattern),
    matchBasename: !pattern.includes("/"),
  }));
  return {
    format: files.filter(
      (file) =>
        !ignores.some(({ glob, matchBasename }) =>
          glob.match(matchBasename ? basename(file) : file),
        ),
    ),
    lint: files.filter((file) => lintExtensions.has(extname(file))),
  };
}

function check(tool: string, args: string[], files: string[]): number {
  if (files.length === 0) return 0;
  console.log(`${tool}: ${files.map((file) => JSON.stringify(file)).join(" ")}`);
  const result = Bun.spawnSync(
    [`./node_modules/.bin/${tool}`, ...args, "--", ...files.map((file) => `./${file}`)],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) console.error(`${tool} が失敗しました (exit ${result.exitCode})`);
  return result.exitCode;
}

function main(): number {
  const staged = Bun.spawnSync(
    ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { stderr: "inherit" },
  );
  if (staged.exitCode !== 0) return staged.exitCode;
  const files = staged.stdout.toString().split("\0").filter(Boolean);
  if (files.length === 0) return 0;
  const config = JSON.parse(readFileSync(".oxfmtrc.json", "utf8"));
  const selected = selectFiles(files, config.ignorePatterns ?? []);
  // .gitignoreなどによって全件除外されても、リポジトリ全体の検査へ戻しません。
  const format = check("oxfmt", ["--check", "--no-error-on-unmatched-pattern"], selected.format);
  const lint = check("oxlint", ["--no-error-on-unmatched-pattern"], selected.lint);
  return format || lint;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
