import { expect, test } from "bun:test";
import { restoreAnalysisPosition } from "../src/analysis";
import { resolveAiOptions } from "../src/ai";
import { createAiContext } from "../src/aiSearchContext";
import { evaluateAiPosition } from "../src/aiEvaluation";
import type { AiSyncModel } from "../src/aiModel";

function finish<T>(steps: Generator<number, T>): T {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

test("自手番Policyは相手順序とValueをG0に保ち、従来Policyの相手推論と区別する", async () => {
  const p = await restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: true,
    },
    events: [],
  });
  const { settings } = resolveAiOptions({
    codeVersion: "policy-own-test",
    maxWork: 100000,
    cacheSize: 32,
  });
  for (const usage of ["policy-own", "policy"] as const) {
    const requests: number[] = [];
    const model: AiSyncModel = {
      modelId: "four-shogi-tiny-policy-value-v1:" + "8".repeat(64),
      predict(input) {
        requests.push(input.features.current.indices.find((i) => i >= 2693 && i <= 2696)! - 2693);
        return {
          id: input.id,
          legalActionIds: input.legalActionIds,
          policyLogits: input.legalActionIds.map((_, i) => i),
          policy: input.legalActionIds.map((_, i) => Number(i === input.legalActionIds.length - 1)),
          topActionId: input.legalActionIds.at(-1)!,
          value: [0.2, 0.2, 0.2, 0.2, 0.2],
          illegalPolicyNonzero: 0,
        };
      },
    };
    const ctx = createAiContext(p.state, settings, undefined, {
      model,
      modelUsage: usage,
      allMoves: true,
      evaluate: (state) => evaluateAiPosition(state, settings.evaluationWeights),
    });
    finish(ctx.rootOrder());
    expect(requests).toEqual([0]);
    const next = finish(ctx.advance(ctx.start, ctx.legal[0], 0)).state;
    expect(next.turn).not.toBe("south");
    const legal = finish(ctx.moves(next));
    const ordered = finish(ctx.ordered(next, legal));
    expect(ordered.map((x) => x.index).sort((a, b) => a - b)).toEqual(legal.map((_, i) => i));
    expect(requests.filter((side) => side !== 0).length > 0).toBe(usage === "policy");
    expect(finish(ctx.evaluate(next))).toEqual(
      evaluateAiPosition(next, settings.evaluationWeights),
    );
    expect(ctx.metrics.modelValueUses ?? 0).toBe(0);
    expect(ctx.metrics.modelPolicyRootUses).toBeGreaterThan(0);
    expect((ctx.metrics.modelPolicyOpponentUses ?? 0) > 0).toBe(usage === "policy");
  }
});
