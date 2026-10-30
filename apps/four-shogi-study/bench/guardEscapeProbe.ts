import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { guardBenchIdentity } from "./lethalGuardBench";
import { efficiencyPhase } from "./guardEfficiency";
import { restoreStudyPosition } from "../src/domain/study";
import {
  proveFiniteAction,
  validateFiniteProof,
} from "../../../packages/four-shogi/src/finiteSurvival";
import { orderGuardReplies } from "../src/search/guardReplyOrder";

export async function probeGuardEscapes(directory: string) {
  const read = (p: string) => JSON.parse(readFileSync(join(directory, p), "utf8"));
  const results: any[] = [],
    source = guardBenchIdentity();
  await efficiencyPhase(directory, "escapes-probe", async (deadline) => {
    for (const id of ["ae960d72d889183a-95", "f1c8fdef9f37da03-146"]) {
      const record = read("inputs/" + id + ".json");
      const p = await restoreStudyPosition({
        origin: { kind: "replay", replay: record.replay },
        events: [],
      });
      const safe = read("validation/known.json")
        .results.filter((r: any) => r.id === id && r.order === "base" && r.proof.status === "safe")
        .map((r: any) => r.action);
      for (const action of [record.chosenAction, ...safe])
        for (const mode of ["simple", "escapes"] as const) {
          if (performance.now() >= deadline) throw Error("全体予算終了");
          const proof = await proveFiniteAction(p, action, record.side, 4, {
            maxTransitions: 5000,
            maxMs: 500,
            maxWork: 100000,
            maxNodes: 4096,
            maxBytes: 16777216,
            measureStages: true,
            order: (p, a) => orderGuardReplies(p, a, record.side, mode),
          });
          const validation = await validateFiniteProof(p, proof);
          results.push({ id, action, mode, proof, validation });
        }
    }
    writeFileSync(
      join(directory, "validation/escapes-probe.json"),
      JSON.stringify({
        source,
        scope: "Known actions only; extra diagnostic time, not total2s or candidate discovery.",
        results,
        complete: true,
      }) + "\n",
    );
    console.log(
      JSON.stringify(
        results.map((r) => ({
          id: r.id,
          mode: r.mode,
          status: r.proof.status,
          ms: r.proof.elapsedMs,
          transitions: r.proof.transitions,
          orderMs: r.proof.metrics.orderingMs,
        })),
      ),
    );
  });
}
if (import.meta.main) await probeGuardEscapes(resolve(Bun.argv[2]));
