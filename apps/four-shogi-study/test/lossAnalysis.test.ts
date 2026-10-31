import { expect, test } from "bun:test";
import { advanceAnalysisPosition, getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { fixture, move } from "../../../packages/four-shogi/bench/positionFixture";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { restoreStudyPosition } from "../src/domain/study";
import { proveFiniteAction, validateFiniteProof } from "../bench/lossSafety";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import { selectMajorLossActions } from "../bench/lossAnalysis";
import type { LossCase } from "../bench/lossAnalysisCases";
import type { PolicyRow } from "../bench/lossAnalysisWorker";

test("有限の全応手安全性を証明し、応手を欠いた証明を正本再生で拒否する", async () => {
  const position = await restoreStudyPosition(tacticInput(fixture()));
  const action = getAnalysisLegalActions(position)[0];
  const proof = await proveFiniteAction(position, action, "south", 2, {
    maxTransitions: 1000,
    maxMs: 1000,
  });
  expect(proof.status).toBe("safe");
  expect((await validateFiniteProof(position, proof)).verified).toBe(true);
  const damaged = structuredClone(proof);
  damaged.nodes[damaged.entry!].edges.pop();
  await expect(validateFiniteProof(position, damaged)).rejects.toThrow("欠落");
});

test("予算切れは安全へ繰り上げず、非合法初手も検証しない", async () => {
  const position = await restoreStudyPosition(tacticInput(fixture()));
  const action = getAnalysisLegalActions(position)[0];
  const incomplete = await proveFiniteAction(position, action, "south", 4, {
    maxTransitions: 0,
    maxMs: 1000,
  });
  expect(incomplete.status).toBe("unknown");
  expect((await validateFiniteProof(position, incomplete)).verified).toBe(false);
  await expect(
    proveFiniteAction(
      position,
      { type: "movePiece", from: { x: 4, y: 4 }, to: { x: 4, y: 5 }, promote: false },
      "south",
      2,
      { maxTransitions: 100, maxMs: 100 },
    ),
  ).rejects.toThrow("非合法");
});

test("合法な詰み応手の存在を証明し、全応手が詰みだとは読み替えない", async () => {
  const position = await restoreStudyPosition(
    tacticInput(
      fixture({
        kings: { south: "A9", west: "C8", north: "I1", east: "I9" },
        pieces: [
          { side: "west", kind: "rook", at: "C7" },
          { side: "west", kind: "gold", at: "B8" },
          { side: "south", kind: "pawn", at: "E5" },
        ],
      }),
    ),
  );
  const action = move("E5", "E4");
  const after = await advanceAnalysisPosition(position, { type: "action", side: "south", action });
  const proof = await proveFiniteAction(position, action, "south", 2, {
    maxTransitions: 100,
    maxMs: 1000,
    preferred: { [after.stateHash]: [encodeAction(move("C7", "A7"))] },
  });
  expect(proof.status).toBe("unsafe");
  expect(proof.opponentModel).toBe("all-opponents-adversarial");
  expect((await validateFiniteProof(position, proof)).verified).toBe(true);
  expect(proof.nodes[proof.entry!].edges.length).toBeLessThan(
    proof.nodes[proof.entry!].legal.length,
  );
});

test("主要候補は実着手を保持し、方針限定の復帰手と低い静的順位も固定規則で残す", async () => {
  const position = await restoreStudyPosition(tacticInput(fixture()));
  const legal = [...getAnalysisLegalActions(position)];
  const record = { chosenAction: legal[0], legalActions: legal } as LossCase;
  const rows = legal.map(
    (action, index) =>
      ({
        action,
        actionId: encodeAction(action),
        rootIndex: index,
        staticRank: index + 1,
        status: index === legal.length - 1 ? "returned" : "eliminated",
      }) as PolicyRow,
  );
  const selected = selectMajorLossActions(record, rows, null);
  expect(selected[0]).toBe(encodeAction(legal[0]));
  expect(selected).toContain(encodeAction(legal.at(-1)!));
  expect(new Set(selected).size).toBe(selected.length);
  expect(selected.length).toBeLessThanOrEqual(6);
});
