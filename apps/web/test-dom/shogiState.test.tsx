import type { FourShogiRoom } from "@tetraboard/protocol";
import { expect, test } from "bun:test";
import {
  applyAction,
  eliminateSide,
  sides,
  type FourShogiAction,
  formationAnalysisVersion,
} from "@tetraboard/four-shogi";
import {
  formationAction,
  formationState,
  formationCases,
} from "../../../test-fixtures/shogiFormations";
import {
  useShogiPromotion,
  type ShogiPromotionContext,
} from "../src/features/room/useShogiPromotion";
import { useShogiFormationNotice } from "../src/features/room/useShogiFormationNotice";
import { useDelayedMoveNotice } from "../src/features/room/useDelayedMoveNotice";
import type { PendingShogiAction } from "../src/features/room/fourShogiSessionBehavior";
import {
  initialShogiState,
  playingShogiRoom,
  waitingShogiRoom,
} from "../test/fixtures/fourShogiFixtures";
import { playerIds } from "../test/fixtures/rooms";
import { act, denyStorage, clock, renderHook } from "./harness";

const actions: Extract<FourShogiAction, { type: "movePiece" }>[] = [true, false].map((promote) => ({
  type: "movePiece",
  from: { x: 3, y: 3 },
  to: { x: 3, y: 2 },
  promote,
}));
const context: ShogiPromotionContext = {
  instanceId: "instance",
  playerId: "player",
  roundId: "round",
  positionRevision: 1,
  side: "south",
  confirmed: true,
};
const usePromotionProbe = (p: {
  context?: ShogiPromotionContext;
  actions: readonly FourShogiAction[];
  enabled: boolean;
}) => useShogiPromotion(p.context, p.actions, p.enabled);
const input = { context, actions, enabled: true };
test("成りの保存と復元は同局面だけ、一時切断・未確認・操作不可でもintentを保持", () => {
  const h = renderHook(usePromotionProbe, input);
  act(() => h.current.open(actions));
  expect(h.current.choices).toEqual(actions);
  h.rerender({ ...input, context: { ...context, confirmed: false }, actions: [], enabled: false });
  expect(h.current.choices).toBeNull();
  expect(sessionStorage.length).toBe(1);
  h.unmount();
  const restored = renderHook(usePromotionProbe, input);
  expect(restored.current.choices).toEqual(actions);
  act(() => restored.current.clear());
  expect(restored.current.choices).toBeNull();
  expect(sessionStorage.length).toBe(0);
});
test("別revision・局・本人・世代・side・脱落と合法な二択不足は保存成りを破棄", () => {
  for (const next of [
    { positionRevision: 2 },
    { roundId: "next" },
    { playerId: "other" },
    { instanceId: "new" },
    { side: "west" as const },
  ]) {
    const h = renderHook(usePromotionProbe, input);
    act(() => h.current.open(actions));
    h.rerender({ ...input, context: { ...context, ...next } });
    expect(h.current.choices).toBeNull();
    expect(sessionStorage.length).toBe(0);
    h.unmount();
  }
  for (const candidates of [[], [actions[0]!], [actions[1]!], [actions[0]!, actions[0]!]]) {
    const h = renderHook(usePromotionProbe, input);
    act(() => h.current.open(actions));
    h.rerender({ ...input, actions: candidates });
    expect(h.current.choices).toBeNull();
    expect(sessionStorage.length).toBe(0);
    h.unmount();
  }
  const h = renderHook(usePromotionProbe, input);
  act(() => h.current.open(actions));
  h.rerender({ ...input, context: undefined });
  expect(h.current.choices).toBeNull();
});
test("壊れた保存値とstorage失敗でも成りをその場で選択・取消できる", () => {
  const key = "tetraboard:shogi-promotion:instance:player";
  for (const raw of [
    "{",
    "null",
    JSON.stringify({ ...context, from: { x: 99, y: 0 }, to: { x: 0, y: 0 } }),
    JSON.stringify({ ...context, positionRevision: -1 }),
  ]) {
    sessionStorage.setItem(key, raw);
    const h = renderHook(usePromotionProbe, input);
    expect(h.current.choices).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
    h.unmount();
  }
  const failure = denyStorage();
  try {
    const h = renderHook(usePromotionProbe, input);
    act(() => h.current.open(actions));
    expect(h.current.choices).toEqual(actions);
    act(() => h.current.clear());
    expect(h.current.choices).toBeNull();
  } finally {
    failure.mockRestore();
  }
});
test("3秒通知は元の送信時刻から測り、古いタイマーを次の着手へ持ち越さない", () => {
  const first: Extract<PendingShogiAction, { type: "move" }> = {
    type: "move",
    roundId: "r",
    positionRevision: 0,
    participant: "south",
    action: actions[0]!,
    startedAtMs: 0,
  };
  const h = renderHook(useDelayedMoveNotice, first as typeof first | null);
  clock.advance(2000);
  h.rerender(null);
  const second = { ...first, positionRevision: 1, startedAtMs: clock.now };
  h.rerender(second);
  clock.advance(1000);
  expect(h.current).toBeNull();
  clock.advance(1999);
  expect(h.current).toBeNull();
  clock.advance(1);
  expect(h.current).toBe("着手を送信中…");
  h.rerender(null);
  expect(h.current).toBeNull();
  h.rerender({ ...first, startedAtMs: clock.now - 3001 });
  clock.advance(0);
  expect(h.current).toBe("着手を送信中…");
});

test("確定した本人着手の戦型だけを4方向で通知し1999/2000msで解除、再読込で抑止", () => {
  for (const side of sides) {
    sessionStorage.clear();
    const before = formationState(initialShogiState(), "riggtosfar", side, false);
    const completed = applyAction(before, side, formationAction("riggtosfar", side));
    if (!completed.ok) throw new Error("fixture");
    const player = playerIds[sides.indexOf(side)]!;
    const first = playingShogiRoom(before),
      next = playingShogiRoom(completed.state, 1);
    const h = renderHook(
      (p: { room: typeof first; ready: boolean }) =>
        useShogiFormationNotice(p.room, player, p.ready),
      { room: first, ready: true },
    );
    expect(h.current.notice).toBeNull();
    h.rerender({ room: next, ready: true });
    expect(h.current.notice?.name).toBe("リッグトスファー");
    clock.advance(1999);
    expect(h.current.notice).not.toBeNull();
    clock.advance(1);
    expect(h.current.notice).toBeNull();
    h.rerender({ room: first, ready: false });
    h.rerender({ room: next, ready: true });
    expect(h.current.notice).toBeNull();
    h.unmount();
    const reloaded = renderHook(
      (room: typeof first) => useShogiFormationNotice(room, player, true),
      first,
    );
    reloaded.rerender(next);
    expect(reloaded.current.notice).toBeNull();
    reloaded.unmount();
  }
});

test.each([
  { id: "lower-gold" as const, name: "地下鉄飛車・下段金寄せ" },
  { id: "yuzuu-muge" as const, name: "地下鉄飛車・融通無碍" },
])("$name: 1戦型として通知し、置換・2秒消去・全16種類の記録復元に対応", ({ id, name }) => {
  const before = formationState(initialShogiState(), id, "south", false);
  const completed = applyAction(before, "south", formationAction(id));
  if (!completed.ok) throw new Error("fixture");
  const first = playingShogiRoom(before),
    next = playingShogiRoom(completed.state, 1);
  const h = renderHook(
    (room: FourShogiRoom) => useShogiFormationNotice(room, playerIds[0], true),
    first,
  );
  h.rerender(next);
  expect(h.current.notice).toEqual({ ids: [id], name });
  clock.advance(1999);
  expect(h.current.notice?.name).toBe(name);
  const key = `tetraboard:room:${first.instanceId}:${playerIds[0]}:formations`;
  expect(JSON.parse(sessionStorage.getItem(key)!).seen).toEqual([id]);
  const fiveBefore = formationState(initialShogiState(), "five", "south", false);
  const five = applyAction(fiveBefore, "south", formationAction("five"));
  if (!five.ok) throw new Error("fixture");
  h.rerender(playingShogiRoom({ ...five.state, moveNumber: 2 }, 2));
  expect(h.current.notice?.name).toBe("ファイブ");
  clock.advance(1999);
  expect(h.current.notice?.name).toBe("ファイブ");
  clock.advance(1);
  expect(h.current.notice).toBeNull();
  h.unmount();

  // 解析器から期待IDを作らず、独立fixtureの全16種類を記録する。
  sessionStorage.setItem(
    key,
    JSON.stringify({
      scope: `${first.instanceId}:${playerIds[0]}:${first.roundId}:${formationAnalysisVersion}`,
      seen: formationCases.map((fixture) => fixture.id),
    }),
  );
  for (const id of ["lower-gold", "yuzuu-muge", "five", "tenshukaku-ship"] as const) {
    const state = formationState(initialShogiState(), id, "south", false);
    const result = applyAction(state, "south", formationAction(id));
    if (!result.ok) throw new Error("fixture");
    const restored = renderHook(
      (room: FourShogiRoom) => useShogiFormationNotice(room, playerIds[0], true),
      playingShogiRoom(state),
    );
    expect(JSON.parse(sessionStorage.getItem(key)!).seen).toHaveLength(16);
    restored.rerender(playingShogiRoom(result.state, 1));
    expect(restored.current.notice).toBeNull();
    restored.unmount();
  }
});

test.each([1, 2])(
  "解析版%dの通知記録は基準局面へ置き換え、版3で新たに成立した戦型を通知",
  (version) => {
    const state = formationState(initialShogiState(), "five", "south", false);
    const result = applyAction(state, "south", formationAction("five"));
    if (!result.ok) throw new Error("fixture");
    const first = playingShogiRoom(state);
    const key = `tetraboard:room:${first.instanceId}:${playerIds[0]}:formations`;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        scope: `${first.instanceId}:${playerIds[0]}:${first.roundId}:${version}`,
        seen: ["five", "subway-rook"],
      }),
    );
    const h = renderHook(
      (room: FourShogiRoom) => useShogiFormationNotice(room, playerIds[0], true),
      first,
    );
    expect(h.current.notice).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(key)!).scope).toEndWith(":3");
    h.rerender(playingShogiRoom(result.state, 1));
    expect(h.current.notice?.name).toBe("ファイブ");
    h.unmount();

    sessionStorage.setItem(
      key,
      JSON.stringify({
        scope: `${first.instanceId}:${playerIds[0]}:${first.roundId}:${version}`,
        seen: ["subway-rook"],
      }),
    );
    const established = renderHook(
      (room: FourShogiRoom) => useShogiFormationNotice(room, playerIds[0], true),
      playingShogiRoom(result.state, 1),
    );
    expect(established.current.notice).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
      scope: `${first.instanceId}:${playerIds[0]}:${first.roundId}:3`,
      seen: ["five"],
    });
    established.unmount();
  },
);
test("戦型の操作取消・切断・次局・保存不可を処理し、初回成立や他人は通知しない", () => {
  const before = formationState(initialShogiState(), "tenshukaku", "south", false),
    result = applyAction(before, "south", formationAction("tenshukaku", "south"));
  if (!result.ok) throw new Error("fixture");
  const first = playingShogiRoom(before),
    formed = playingShogiRoom(result.state, 1);
  const failure = denyStorage();
  try {
    const h = renderHook(
      (room: typeof first) => useShogiFormationNotice(room, playerIds[0], true),
      first,
    );
    h.rerender(formed);
    expect(h.current.notice).not.toBeNull();
    act(() => h.current.dismiss());
    expect(h.current.notice).toBeNull();
    h.rerender(first);
    h.rerender(formed);
    expect(h.current.notice).toBeNull();
    h.unmount();
  } finally {
    failure.mockRestore();
  }
  const h = renderHook(
    (p: { room: FourShogiRoom; player?: string; ready: boolean }) =>
      useShogiFormationNotice(p.room, p.player, p.ready),
    { room: formed, player: playerIds[1], ready: true },
  );
  expect(h.current.notice).toBeNull();
  h.rerender({ room: waitingShogiRoom(), player: undefined, ready: false });
  expect(h.current.notice).toBeNull();
});

test("戦型通知は切断・脱落・観戦・待機で消去し、飛んだrevisionでは通知せず次局で記録を更新", () => {
  const before = formationState(initialShogiState(), "tenshukaku", "south", false);
  const result = applyAction(before, "south", formationAction("tenshukaku", "south"));
  if (!result.ok) throw new Error("fixture");
  const first = playingShogiRoom(before),
    formed = playingShogiRoom(result.state, 1);
  type Input = { room: FourShogiRoom; player?: string; ready: boolean };
  const useNoticeProbe = (p: Input) => useShogiFormationNotice(p.room, p.player, p.ready);
  const input: Input = { room: first, player: playerIds[0], ready: true };
  const elimination = eliminateSide(result.state, "south", "left");
  if (!elimination.ok) throw new Error("fixture");
  const removed = playingShogiRoom(elimination.state, 2);
  for (const change of [
    { room: formed, ready: false },
    { room: removed, ready: true },
    { room: formed, ready: true, player: undefined },
    { room: waitingShogiRoom(), ready: true },
  ]) {
    sessionStorage.clear();
    const h = renderHook(useNoticeProbe, input);
    h.rerender({ ...input, room: formed });
    expect(h.current.notice).not.toBeNull();
    h.rerender({ ...input, ...change });
    expect(h.current.notice).toBeNull();
    h.unmount();
  }
  sessionStorage.clear();
  const h = renderHook(useNoticeProbe, input);
  h.rerender({ ...input, room: { ...formed, positionRevision: 5 } });
  expect(h.current.notice).toBeNull();
  const next = { ...first, roundId: crypto.randomUUID() };
  h.rerender({ ...input, room: next });
  const key = `tetraboard:room:${first.instanceId}:${playerIds[0]}:formations`;
  expect(JSON.parse(sessionStorage.getItem(key)!).scope).toContain(next.roundId);
  expect(JSON.parse(sessionStorage.getItem(key)!).seen).toEqual([]);
  h.rerender({ ...input, room: { ...formed, roundId: next.roundId } });
  expect(h.current.notice).not.toBeNull();
});
