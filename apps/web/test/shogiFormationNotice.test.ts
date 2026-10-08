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
  const other = detectFormations(formationState(initial, "lower-gold"), "south");
  const latest = advanceFormationTracker(first, {
    ...formed,
    revision: 12,
    moveNumber: 8,
    matches: other,
  });
  expect(latest.notice).toEqual({
    ids: ["lower-gold"],
    name: "地下鉄飛車・下段金寄せ",
  });
  const repeated = advanceFormationTracker(latest, { ...formed, revision: 13, moveNumber: 9 });
  expect(repeated.notice).toBe(latest.notice);
});

test.each([
  { id: "lower-gold" as const, name: "地下鉄飛車・下段金寄せ" },
  { id: "yuzuu-muge" as const, name: "地下鉄飛車・融通無碍" },
])("$name: 1戦型として通知し、同じ戦型の再成立を抑止する", ({ id, name }) => {
  const completedFormation = {
    ...formed,
    matches: detectFormations(formationState(initial, id), "south"),
  };
  const notified = advanceFormationTracker(initialFormationTracker(start), completedFormation);
  expect(notified.notice).toEqual({ ids: [id], name });
  expect(notified.seen).toEqual([id]);
  const absent = advanceFormationTracker(
    { ...notified, notice: null },
    { ...start, revision: 12, moveNumber: 8 },
  );
  expect(
    advanceFormationTracker(absent, { ...completedFormation, revision: 13, moveNumber: 9 }).notice,
  ).toBeNull();
  const known = advanceFormationTracker(initialFormationTracker(start, [id]), completedFormation);
  expect(known.notice).toBeNull();
});

test("異なる戦型の同時成立は名称を連結し、新たに通知した全IDを抑止する", () => {
  const state = formationState(initial, "tenshukaku");
  // 天守閣玉に銀D8・金E9を追加すると、天守閣シップ・抜刀銀も成立します。
  state.board[7][3] = { id: 100, side: "south", kind: "silver", promoted: false };
  state.board[8][4] = { id: 101, side: "south", kind: "gold", promoted: false };
  const observation = { ...formed, matches: detectFormations(state, "south") };
  const notified = advanceFormationTracker(initialFormationTracker(start), observation);
  expect(notified.notice).toEqual({
    ids: ["tenshukaku", "tenshukaku-ship", "batto-silver"],
    name: "天守閣玉・天守閣シップ・抜刀銀",
  });
  expect(notified.seen).toEqual(["tenshukaku", "tenshukaku-ship", "batto-silver"]);
  const oneKnown = advanceFormationTracker(
    initialFormationTracker(start, ["tenshukaku"]),
    observation,
  );
  expect(oneKnown.notice).toEqual({
    ids: ["tenshukaku-ship", "batto-silver"],
    name: "天守閣シップ・抜刀銀",
  });
});
