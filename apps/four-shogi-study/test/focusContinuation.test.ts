import { expect, test } from "bun:test";
import { createStudy, restoreStudyPosition, studyPositionInput } from "../src/domain/study";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  restoreAnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import { createStudyRootSearch } from "@tetraboard/four-shogi/study-search";
import { createFocusHints, prioritizeFocusRoots } from "../src/search/focusContinuation";
const identity = {
  scope: "game-a",
  side: "south" as const,
  conditions: "P05/root4/depth256/ext2/width6",
};
async function sample() {
  const study = await createStudy();
  const p = await restoreStudyPosition(studyPositionInput(study));
  const s = createStudyRootSearch(p, { strategy: "dual-continuations", maxDepth: 2 });
  try {
    while (!s.step()) {}
    return { study, p, candidates: s.snapshot().candidates };
  } finally {
    s.dispose();
  }
}
test("実着手に一致した完成PVの残りは合法な順序ヒントとして使え、評価は移植しない", async () => {
  const { p, candidates } = await sample();
  const before = p.stateHash,
    hints = createFocusHints();
  await hints.offer(p, identity, candidates);
  const a = candidates[0].line[0],
    next = await advanceAnalysisPosition(p, { type: "action", side: a.side, action: a.action });
  expect(hints.get(next, identity)?.action).toEqual(candidates[0].line[1].action);
  expect(hints.get(next, identity)).not.toHaveProperty("evaluation");
  expect(p.stateHash).toBe(before);
});
test("根のヒントは選別済み集合を変えず、未選別手や不一致の手を追加しない", () => {
  const actions = [0, 1, 2].map((x) => ({
    type: "dropPiece" as const,
    pieceKind: "gold" as const,
    to: { x, y: 4 },
  }));
  const candidates = actions.map((action, rootIndex) => ({ action, rootIndex }));
  const queue = [2, 0];
  expect(prioritizeFocusRoots(queue, candidates, actions[0])).toEqual([0, 2]);
  expect(prioritizeFocusRoots(queue, candidates, actions[1])).toEqual(queue);
  expect(queue).toEqual([2, 0]);
});
test("別対局・別方針・同hashでも参加者の違う局面・未完成PVを使わない", async () => {
  const { study, p, candidates } = await sample();
  const hints = createFocusHints();
  await hints.offer(p, identity, candidates);
  expect(hints.get(p, { ...identity, scope: "game-b" })).toBeNull();
  expect(hints.get(p, { ...identity, conditions: "otherwidth" })).toBeNull();
  if (study.origin.kind !== "replay") throw Error();
  const other = await restoreAnalysisPosition({
    ...study.origin.replay,
    initial: {
      ...study.origin.replay.initial,
      players: { ...study.origin.replay.initial.players, south: "otherperson" },
    },
  });
  expect(other.stateHash).toBe(p.stateHash);
  expect(hints.get(other, identity)).toBeNull();
  hints.clear();
  await hints.offer(
    p,
    identity,
    candidates.map((c) => ({ ...c, completedDepth: 0 })),
  );
  expect(hints.get(p, identity)).toBeNull();
});
test("容量・TTL・取消で保持を制限し、改変や解析API外の局面を利用しない", async () => {
  const { p, candidates } = await sample();
  let clock = 0;
  const hints = createFocusHints({ maxEntries: 2, ttlMs: 10, now: () => clock });
  await hints.offer(p, identity, candidates);
  expect(hints.stats().entries).toBeLessThanOrEqual(2);
  const key = candidates[Math.min(3, candidates.length - 1)].line[0];
  const next = await advanceAnalysisPosition(p, {
    type: "action",
    side: key.side,
    action: key.action,
  });
  const hinted = hints.get(next, identity);
  expect(hinted).not.toBeNull();
  if (hinted) {
    hinted.action.type === "movePiece" && Object.assign(hinted.action.to, { x: 99 });
    expect(getAnalysisLegalActions(next)).toContainEqual(hints.get(next, identity)!.action);
  }
  clock = 11;
  expect(hints.get(next, identity)).toBeNull();
  hints.clear();
  expect(hints.stats().entries).toBe(0);
  expect(() => hints.get(structuredClone(p), identity)).toThrow("解析API");
});

test("PVを正本再生中に取り消した結果は後から保持されない", async () => {
  const { p, candidates } = await sample(),
    hints = createFocusHints();
  const pending = hints.offer(p, identity, candidates);
  hints.clear();
  await pending;
  expect(hints.stats().entries).toBe(0);
});
