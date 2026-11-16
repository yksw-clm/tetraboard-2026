import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { argv } from "node:process";
import { parseArgs } from "node:util";
import { conversionReportSchema, planSnapshotMatches, readMatchExport } from "./snapshotMatchPlan";
import {
  apiSnapshotSchema,
  compareSnapshots,
  invalidSnapshotResponses,
  snapshotMatches,
} from "./snapshotMatchSnapshots";

const usage = `Usage:
  bun scripts/convertSnapshotMatches.ts plan --input <export.json>... --out <directory> [--batch-size 50]
  bun scripts/convertSnapshotMatches.ts snapshot --report <report.json> --base <URL> --out <directory> [--interval-ms 250]
  bun scripts/convertSnapshotMatches.ts compare --before <directory> --after <directory>`;
async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function freshDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await readdir(path)).length) throw new Error(`Output directory must be empty: ${path}`);
}
async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}\n${usage}`);
  return value;
}
async function plan(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      input: { type: "string", multiple: true },
      out: { type: "string" },
      "batch-size": { type: "string", default: "50" },
    },
  });
  if (!values.input?.length) throw new Error(usage);
  const out = required(values.out, "--out");
  const rows = [];
  for (const path of [...values.input, ...positionals])
    rows.push(...readMatchExport(await readJson(path)));
  const result = planSnapshotMatches(rows, { batchSize: Number(values["batch-size"]) });
  await freshDirectory(out);
  for (const [name, sql] of Object.entries(result.files))
    await writeFile(join(out, name), sql, { mode: 0o600 });
  await writeJson(join(out, "report.json"), result.report);
  console.log(JSON.stringify(result.report, null, 2));
  if (result.report.failed.length) process.exitCode = 1;
}
async function snapshot(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      report: { type: "string" },
      base: { type: "string" },
      out: { type: "string" },
      "interval-ms": { type: "string", default: "250" },
    },
  });
  const report = conversionReportSchema.parse(await readJson(required(values.report, "--report")));
  const out = required(values.out, "--out");
  const base = required(values.base, "--base");
  await freshDirectory(out);
  const saved = await snapshotMatches(report, base, {
    intervalMs: Number(values["interval-ms"]),
    save: (value) => writeJson(join(out, "snapshot.json"), value),
  });
  await writeJson(join(out, "snapshot.json"), saved);
  const invalid = invalidSnapshotResponses(saved);
  console.log(
    JSON.stringify(
      { saved: saved.matches.length, out, invalidCount: invalid.length, invalid },
      null,
      2,
    ),
  );
}
async function compare(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { before: { type: "string" }, after: { type: "string" } },
  });
  const before = apiSnapshotSchema.parse(
    await readJson(join(required(values.before, "--before"), "snapshot.json")),
  );
  const after = apiSnapshotSchema.parse(
    await readJson(join(required(values.after, "--after"), "snapshot.json")),
  );
  const result = compareSnapshots(before, after);
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length) process.exitCode = 1;
}
try {
  const [command, ...args] = argv.slice(2);
  switch (command) {
    case "plan":
      await plan(args);
      break;
    case "snapshot":
      await snapshot(args);
      break;
    case "compare":
      await compare(args);
      break;
    default:
      throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
