import { expect, test } from "bun:test";
import { createInitialState, detectFormations } from "@tetraboard/four-shogi";
import { formationState } from "../../../test-fixtures/shogiFormations";
import {
  advanceFormationTracker,
  initialFormationTracker,
  type FormationObservation,
} from "../src/features/room/shogiFormationNotice";

const start: FormationObservation = {
  scope: "room:player:round:1",
  ready: true,
  revision: 10,
  moveNumber: 6,
  ownMove: false,
  matches: [],
};
const initial = createInitialState({
  mode: "singles",
  players: { south: "p1", west: "p2", north: "p3", east: "p4" },
});
const matches = detectFormations(formationState(initial, "tenshukaku"), "south");
const formed: FormationObservation = {
  ...start,
  revision: 11,
  moveNumber: 7,
  ownMove: true,
  matches,
};
test("本人の連続した確定着手だけを通知し、同じ戦型は局内1回", () => {
  let tracker = advanceFormationTracker(initialFormationTracker(start), formed);
  expect(tracker.notice?.name).toBe("天守閣玉");
  tracker = { ...tracker, notice: null };
  tracker = advanceFormationTracker(tracker, {
    ...formed,
    revision: 12,
    moveNumber: 8,
    matches: [],
  });
  tracker = advanceFormationTracker(tracker, { ...formed, revision: 13, moveNumber: 9 });
  expect(tracker.notice).toBeNull();
  tracker = advanceFormationTracker(tracker, { ...start, scope: "room:player:next-round:1" });
  expect(
    advanceFormationTracker(tracker, { ...formed, scope: "room:player:next-round:1" }).notice?.name,
  ).toBe("天守閣玉");
});
test("初回・認証・再接続・飛んだ局面・他人の着手・引分通知は基準として扱う", () => {
  expect(initialFormationTracker(formed).notice).toBeNull();
  expect(initialFormationTracker(start, [matches[0].id]).seen).toContain(matches[0].id);
  for (const previous of [start, { ...start, ready: false }])
    for (const next of [
      { ...formed, ready: false },
      { ...formed, revision: 14 },
      { ...formed, ownMove: false },
      { ...formed, moveNumber: 6 },
    ])
      expect(advanceFormationTracker(initialFormationTracker(previous), next).notice).toBeNull();
  const visible = advanceFormationTracker(initialFormationTracker(start), formed);
  expect(advanceFormationTracker(visible, { ...formed, ready: false }).notice).toBeNull();
  expect(advanceFormationTracker(visible, { ...formed, scope: null }).notice).toBeNull();
  expect(advanceFormationTracker(visible, formed).notice).toBe(visible.notice);
});
test("別の戦型は最新へ置き換え、既知の戦型で表示を開始し直さない", () => {
  const first = advanceFormationTracker(initialFormationTracker(start), formed);
  const other = detectFormations(formationState(initial, "subway-rook"), "south");
  const latest = advanceFormationTracker(first, {
    ...formed,
    revision: 12,
    moveNumber: 8,
    matches: other,
  });
  expect(latest.notice?.id).toBe("subway-rook");
  const repeated = advanceFormationTracker(latest, { ...formed, revision: 13, moveNumber: 9 });
  expect(repeated.notice).toBe(latest.notice);
});
