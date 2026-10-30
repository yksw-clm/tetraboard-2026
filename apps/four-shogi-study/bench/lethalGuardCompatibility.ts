import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import { parallelTrial } from "./parallelSearch";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { tacticInput } from "./tacticsDiagnostics";
import { repoRoot } from "../../../packages/four-shogi/bench/baseline";
import type { StudySearchRuntime, StudySearchSnapshot } from "../src/search/runtime";
import type { StudyPositionInput } from "../src/shared/model";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";

export async function compareGuardOffReference(directory: string) {
  const reference = "8943d70e065f5a5a0fcc32cd635c9aa83f75ab8d",
    root = join(directory, "reference-source");
  mkdirSync(root, { recursive: true });
  const archive = execFileSync("git", ["archive", reference, "apps/four-shogi-study/src"], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", root], { input: archive });
  if (!existsSync(join(root, "node_modules")))
    symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  const old = await import(
    pathToFileURL(join(root, "apps/four-shogi-study/src/search/runtime.ts")).href
  );
  const inputs: StudyPositionInput[] = [
    tacticInput(fixture()),
    ...["ae960d72d889183a-95", "f1c8fdef9f37da03-146"].map((id) => ({
      origin: {
        kind: "replay" as const,
        replay: JSON.parse(readFileSync(join(directory, "inputs", id + ".json"), "utf8")).replay,
      },
      events: [],
    })),
  ];
  const normalize = (s: StudySearchSnapshot) => ({
    candidates: s.candidates,
    action: s.recommendedAction,
    evaluation: s.evaluation,
    work: s.work,
    nodes: s.nodes,
    depth: s.completedDepth,
    diagnostics: s.diagnostics,
  });
  const rows = [];
  for (const [index, input] of inputs.entries())
    for (const strategy of ["adaptive", "dual-continuations"] as const) {
      const snapshots = [];
      for (const type of ["reference", "new-off"] as const) {
        const config = { threads: 1, memoryMb: 4096, taskPartition: "root", reuseWorkers: false };
        const runtime: StudySearchRuntime =
          type === "reference"
            ? old.createStudySearchRuntime(config)
            : createGuardedStudySearchRuntime(
                { ...config, taskPartition: "root" },
                { mode: "off" },
              );
        try {
          const { snapshot } = await parallelTrial(
            runtime,
            input,
            { strategy, timeBudgetMs: 30000, maxDepth: 2, broadDepth: 2 },
            20000000,
          );
          snapshots.push(snapshot);
        } finally {
          await runtime.close();
        }
      }
      const a = normalize(snapshots[0]),
        b = normalize(snapshots[1]);
      rows.push({
        input: index,
        strategy,
        complete: a.depth === 2 && b.depth === 2,
        match: hashJson(a) === hashJson(b),
        referenceHash: hashJson(a),
        newHash: hashJson(b),
        reference: a,
        new: b,
      });
      writeFileSync(
        join(directory, "validation/off-compatibility.json"),
        JSON.stringify({
          reference,
          conditions: "1worker/root/4096MiB/maxDepth2/broadDepth2; timing/id/memory excluded",
          rows,
        }) + "\n",
      );
    }
  return rows;
}
if (import.meta.main)
  console.log(
    JSON.stringify(
      (await compareGuardOffReference(resolve(Bun.argv[2]))).map((r) => ({
        input: r.input,
        strategy: r.strategy,
        complete: r.complete,
        match: r.match,
      })),
    ),
  );
