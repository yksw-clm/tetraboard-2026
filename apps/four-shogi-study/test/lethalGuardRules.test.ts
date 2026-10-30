import { expect, test } from "bun:test";
import {
  restoreAnalysisPosition,
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  analysisRuleProfileId,
} from "@tetraboard/four-shogi/analysis";
import { getActiveSides, type Side } from "@tetraboard/four-shogi";
import {
  proveFiniteAction,
  validateFiniteProof,
} from "../../../packages/four-shogi/src/finiteSurvival";
import { fixture, move } from "../../../packages/four-shogi/bench/positionFixture";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { restoreStudyPosition } from "../src/domain/study";

for (const restricted of [false, true])
  for (const alive of [2, 3, 4]) {
    test(`有限検証は生存${alive}人・三人攻撃${restricted}の正本手番を保つ`, async () => {
      const eliminations = [
        { side: "west" as const, reason: "left" as const, rank: 4, group: 1 },
        { side: "north" as const, reason: "left" as const, rank: 3, group: 2 },
      ].slice(0, 4 - alive);
      const position = await restoreStudyPosition(
        tacticInput(fixture({ eliminations, threePlayerAttackProhibited: restricted })),
      );
      expect(getActiveSides(position.state)).toHaveLength(alive);
      const proof = await proveFiniteAction(
        position,
        getAnalysisLegalActions(position)[0],
        "south",
        2,
        { maxTransitions: 100, maxMs: 500 },
      );
      expect(proof.status).toBe("safe");
      expect((await validateFiniteProof(position, proof)).verified).toBe(true);
    });
  }

function events(alternative = false) {
  // 正本analysisテストと同じ、初期配置から受理される反復手順です。
  const setup = [
    ["south", "D8", "D7"],
    ["west", "B4", "C4"],
    ["north", "D2", "D3"],
    ["east", "H4", "G4"],
    ["south", "F8", "F7"],
    ["west", "B6", "C6"],
    ["north", "F2", "F3"],
    ["east", "H6", "G6"],
  ];
  const cycle = [
    ["south", alternative ? "F9" : "D9", alternative ? "F8" : "D8"],
    ["west", "A4", "B4"],
    ["north", "D1", "D2"],
    ["east", "I4", "H4"],
    ["south", alternative ? "F8" : "D8", alternative ? "F9" : "D9"],
    ["west", "B4", "A4"],
    ["north", "D2", "D1"],
    ["east", "H4", "I4"],
  ];
  return Array.from({ length: 32 }, (_, i) => {
    const [side, from, to] = i < 8 ? setup[i] : cycle[(i - 8) % 8];
    return { index: i, event: { type: "action", side: side as Side, action: move(from, to) } };
  });
}
const replay = (alternate = false, offset = 31, restricted = true) => ({
  schemaVersion: 1,
  rulesVersion: 1,
  ruleProfileId: analysisRuleProfileId,
  initial: {
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
    threePlayerAttackProhibited: restricted,
  },
  events: events(alternate),
  eventOffset: offset,
});

for (const restricted of [false, true])
  test(`千日手直前の履歴を維持して有限生存を判定する・禁止${restricted}`, async () => {
    const position = await restoreAnalysisPosition(replay(false, 31, restricted));
    const action = events()[31].event.action;
    const proof = await proveFiniteAction(position, action, "east", 1, {
      maxTransitions: 1,
      maxMs: 500,
    });
    const after = await advanceAnalysisPosition(position, events()[31].event);
    expect(after.state.status).toBe("finished");
    expect(after.state.result?.reason).toBe("repetition");
    expect(proof.status).toBe("safe");
    expect((await validateFiniteProof(position, proof)).verified).toBe(true);
  });

test("盤面・手番・直前手が同じでも反復履歴の違う証明を受理しない", async () => {
  const a = await restoreAnalysisPosition(replay(false, 24));
  const b = await restoreAnalysisPosition(replay(true, 24));
  const { repetitions: ar, ...leftState } = a.state,
    { repetitions: br, ...rightState } = b.state;
  expect(leftState).toEqual(rightState);
  expect(ar).not.toEqual(br);
  const proof = await proveFiniteAction(a, getAnalysisLegalActions(a)[0], "south", 1, {
    maxTransitions: 1,
    maxMs: 500,
  });
  await expect(validateFiniteProof(b, proof)).rejects.toThrow("入力");
});
