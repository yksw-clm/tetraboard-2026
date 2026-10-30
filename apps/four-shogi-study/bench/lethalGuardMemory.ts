import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import { restoreStudyPosition } from "../src/domain/study";
import { timedNormal } from "./lethalGuardCase";
import { guardBenchIdentity } from "./lethalGuardBench";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { validateGuardReport, validateGuardCandidate } from "./lethalGuardValidation";
import type { LethalGuardOptions } from "../src/search/lethalGuard";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";

if (import.meta.main) {
  const [dir, id, name, planName = "quality-plan-v2.json"] = Bun.argv.slice(2),
    root = resolve(dir);
  const plan = JSON.parse(readFileSync(join(root, planName), "utf8"));
  if (hashJson(plan.source) !== hashJson(guardBenchIdentity())) throw Error("RSS比較ソース不一致");
  const record = JSON.parse(readFileSync(join(root, "inputs", id + ".json"), "utf8"));
  const input = { origin: { kind: "replay" as const, replay: record.replay }, events: [] };
  const match = /p05-(short|observe|experimental)-(\d+)/.exec(name);
  const guard: LethalGuardOptions = {
    mode: match && match[1] !== "short" ? (match[1] as "observe" | "experimental") : "off",
    budgetMs: match ? Number(match[2]) : 250,
  };
  const normalMs = match?.[1] === "short" ? 2000 - Number(match[2]) - 10 : 2000;
  const strategy = name.startsWith("v5") ? ("adaptive" as const) : ("dual-continuations" as const);
  let shallow: readonly StudyCandidate[] = [];
  const runtime = createGuardedStudySearchRuntime(
    {
      threads: 4,
      memoryMb: 4096,
      taskPartition: "root",
      reuseWorkers: false,
      measureStages: true,
      onCompletedRoots: (c, d) => {
        if (d === 1) shallow = structuredClone(c);
      },
    },
    guard,
  );
  const directory = join(root, "validation/memory-trials");
  mkdirSync(directory, { recursive: true });
  const stem = join(directory, id + "-" + name);
  const startedAt = Date.now();
  writeFileSync(stem + ".started.json", JSON.stringify({ at: startedAt }));
  try {
    const result = await timedNormal(
      runtime,
      input,
      { strategy, timeBudgetMs: normalMs, broadDepth: 3 },
      normalMs,
    );
    const endedAt = Date.now();
    writeFileSync(stem + ".ended.json", JSON.stringify({ at: endedAt }));
    const position = await restoreStudyPosition(input);
    for (const c of result.snapshot.candidates) await validateGuardCandidate(position, c);
    const validation = result.snapshot.lethalGuard
      ? await validateGuardReport(position, result.snapshot.lethalGuard)
      : null;
    writeFileSync(
      stem + ".json",
      JSON.stringify({
        source: plan.source,
        caseId: id,
        condition: name,
        startedAt,
        endedAt,
        shallowCount: shallow.length,
        validation,
        ...result,
      }) + "\n",
    );
  } finally {
    await runtime.close();
  }
}
