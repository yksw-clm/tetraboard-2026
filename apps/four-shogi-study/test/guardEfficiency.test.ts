import { expect, test } from "bun:test";
import { fixture, move, drop } from "../../../packages/four-shogi/bench/positionFixture";
import { restoreStudyPosition } from "../src/domain/study";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import { orderGuardReplies } from "../src/search/guardReplyOrder";

test("王手順序は駒打ち王手を捕獲より先に調べ、合法手集合と決定性を保つ", async () => {
  const position = await restoreStudyPosition(
    tacticInput(
      fixture({
        turn: "east",
        hands: { east: { rook: 1 } },
        pieces: [
          { side: "east", kind: "rook", at: "H6" },
          { side: "south", kind: "gold", at: "G6" },
        ],
      }),
    ),
  );
  const legal = getAnalysisLegalActions(position),
    checking = encodeAction(drop("rook", "A5")),
    capture = encodeAction(move("H6", "G6"));
  const base = orderGuardReplies(position, legal, "south", "base").map(encodeAction);
  expect(base.indexOf(capture)).toBeLessThan(base.indexOf(checking));
  for (const mode of ["simple", "checks"] as const) {
    const ordered = orderGuardReplies(position, legal, "south", mode).map(encodeAction);
    expect(ordered.indexOf(checking)).toBeLessThan(ordered.indexOf(capture));
    expect([...ordered].sort((a, b) => a - b)).toEqual(
      legal.map(encodeAction).sort((a, b) => a - b),
    );
    expect(orderGuardReplies(position, legal, "south", mode).map(encodeAction)).toEqual(ordered);
  }
});

import {
  proveFiniteAction,
  validateFiniteProof,
} from "../../../packages/four-shogi/src/finiteSurvival";
for (const restricted of [false, true])
  for (const alive of [2, 3, 4])
    test(`全応手有限証明は順序を変えても一致する・${alive}人・禁止${restricted}`, async () => {
      const eliminations = [
        { side: "west" as const, reason: "left" as const, rank: 4, group: 1 },
        { side: "north" as const, reason: "left" as const, rank: 3, group: 2 },
      ].slice(0, 4 - alive);
      const position = await restoreStudyPosition(
        tacticInput(fixture({ eliminations, threePlayerAttackProhibited: restricted })),
      );
      const action = getAnalysisLegalActions(position)[0],
        statuses = [];
      for (const mode of ["base", "simple", "checks"] as const) {
        const proof = await proveFiniteAction(position, action, "south", 3, {
          maxTransitions: 5000,
          maxMs: 2000,
          order: (p, a) => orderGuardReplies(p, a, "south", mode),
        });
        expect(proof.status).not.toBe("unknown");
        expect((await validateFiniteProof(position, proof)).verified).toBe(true);
        statuses.push(proof.status);
      }
      expect(new Set(statuses).size).toBe(1);
    });

import { allocateGuardQuery } from "../src/search/guardBudget";
import type { GuardRow } from "../src/search/lethalGuard";
test("候補別配分は全体残時間を超えず、首位重点と代替確保を区別する", () => {
  expect(allocateGuardQuery("fixed-50", 250, 249, [], 5)).toBe(125);
  expect(allocateGuardQuery("incumbent", 250, 249, [], 5)).toBe(175);
  expect(allocateGuardQuery("reserve", 250, 249, [], 5)).toBe(100);
  const unsafe = { status: "unsafe", proof: null } as GuardRow;
  expect(allocateGuardQuery("progress", 250, 150, [unsafe], 4)).toBe(150);
  for (const p of ["fixed-50", "incumbent", "reserve", "progress"] as const)
    for (const remaining of [0, 1, 10, 100]) {
      expect(allocateGuardQuery(p, 250, remaining, [], 5)).toBeLessThanOrEqual(remaining);
      expect(allocateGuardQuery(p, 250, remaining, [], 5)).toBeGreaterThanOrEqual(0);
    }
});
