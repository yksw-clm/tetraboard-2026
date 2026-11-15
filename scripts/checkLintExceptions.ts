import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = join(root, ".oxlintrc.json");
const lineRules = ["max-lines", "max-lines-per-function"] as const;
type Override = { files: string[]; rules?: Record<string, unknown> };
type Diagnostic = { code?: string; filename: string; severity: string };
const config = (await Bun.file(configPath).json()) as {
  overrides: Override[];
};
const exceptions = lineRules.map((rule) => ({
  rule,
  files: new Set(
    config.overrides.flatMap((override) =>
      override.rules?.[rule] === "off" ? override.files : [],
    ),
  ),
}));
const files = [...new Set(exceptions.flatMap(({ files }) => [...files]))];
const existingFiles = files.filter((file) => existsSync(resolve(root, file)));
let diagnostics: Diagnostic[] = [];

if (existingFiles.length > 0) {
  const probeConfig = {
    ...config,
    overrides: config.overrides.map((override) => ({
      ...override,
      rules: Object.fromEntries(
        Object.entries(override.rules ?? {}).filter(
          ([rule, value]) => !lineRules.some((name) => name === rule && value === "off"),
        ),
      ),
    })),
  };
  // override の相対パスを維持するため、元の設定と同じディレクトリに作ります。
  const probePath = join(dirname(configPath), `.oxlintrc.exceptions-${crypto.randomUUID()}.json`);
  writeFileSync(probePath, JSON.stringify(probeConfig), { flag: "wx" });
  try {
    const child = Bun.spawn(
      [
        join(root, "node_modules/.bin/oxlint"),
        "--config",
        probePath,
        "--format",
        "json",
        ...existingFiles,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    diagnostics = (JSON.parse(stdout) as { diagnostics: Diagnostic[] }).diagnostics;
    const unexpected = diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        !lineRules.some((rule) => diagnostic.code === `eslint(${rule})`),
    );
    if (unexpected.length > 0 || exitCode > 1 || (exitCode !== 0 && diagnostics.length === 0))
      throw new Error(`例外一覧の検査に失敗しました。\n${stderr}\n${JSON.stringify(unexpected)}`);
  } finally {
    rmSync(probePath);
  }
}

for (const { rule, files } of exceptions) {
  const violations = new Set(
    diagnostics
      .filter((diagnostic) => diagnostic.code === `eslint(${rule})`)
      .map((diagnostic) => resolve(root, diagnostic.filename)),
  );
  for (const file of files) {
    if (violations.has(resolve(root, file))) continue;
    console.error(`${file}: ${rule} の例外一覧から外してください（違反がありません）。`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log("lint の例外一覧に不要なファイルはありません。");
