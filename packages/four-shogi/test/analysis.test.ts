import { expect, test } from "bun:test";
import {
  restoreAnalysisPosition,
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  createAnalysisCacheKey,
  analysisRuleProfileId,
  AnalysisInputError,
  type AnalysisPosition,
  type AnalysisCacheIdentity,
} from "../src/analysis";
import { getActiveSides, getCheckState, getLegalActions, type Side } from "../src/index";
import { positionKey } from "../src/repetition";
import type { FourShogiReplayEvent } from "../src/replay";
import { move } from "./helpers";
import singles from "../../../test-fixtures/matches/shogi-singles.json";
import legacy from "../../../test-fixtures/matches/shogi-legacy.json";
import draw from "../../../test-fixtures/matches/shogi-singles-draw.json";

const initial = {
  mode: "singles" as const,
  players: { south: "s", west: "w", north: "n", east: "e" },
  threePlayerAttackProhibited: true,
};
function input(events: unknown = [], eventOffset?: number) {
  return {
    schemaVersion: 1,
    ruleProfileId: analysisRuleProfileId,
    rulesVersion: 1,
    initial,
    events,
    ...(eventOffset === undefined ? {} : { eventOffset }),
  };
}
function repetitionEvents(alternative = false) {
  const setup = [
    ["south", "D8", "D7"],
    ["west", "B4", "C4"],
    ["north", "D2", "D3"],
    ["east", "H4", "G4"],
    ["south", "F8", "F7"],
    ["west", "B6", "C6"],
    ["north", "F2", "F3"],
    ["east", "H6", "G6"],
  ] as const;
  const cycle: readonly (readonly [Side, string, string])[] = [
    ["south", alternative ? "F9" : "D9", alternative ? "F8" : "D8"],
    ["west", "A4", "B4"],
    ["north", "D1", "D2"],
    ["east", "I4", "H4"],
    ["south", alternative ? "F8" : "D8", alternative ? "F9" : "D9"],
    ["west", "B4", "A4"],
    ["north", "D2", "D1"],
    ["east", "H4", "I4"],
  ];
  return Array.from({ length: 32 }, (_, index) => {
    const [side, from, to] = index < 8 ? setup[index] : cycle[(index - 8) % 8];
    return {
      index,
      event: { type: "action", side, action: move(from, to) } satisfies FourShogiReplayEvent,
    };
  });
}

for (const archive of [singles, legacy, draw]) {
  test(`${archive.name}: 既存の固定チェックポイントと攻撃・捕獲・提案・終局を完全状態から再現する`, async () => {
    const before = JSON.stringify(archive);
    for (const checkpoint of archive.checkpoints) {
      const position = await restoreAnalysisPosition({
        ...input(archive.events, checkpoint.index),
        initial: archive.detail.replay.initial,
      });
      const { repetitions, ...game } = position.state;
      const expected = checkpoint.frame.game as typeof checkpoint.frame.game & {
        drawProposals?: string[];
      };
      expect(game as unknown).toEqual({ ...expected, drawProposals: expected.drawProposals ?? [] });
      expect(getCheckState(position.state)).toEqual(checkpoint.frame.checkState);
      expect(getAnalysisLegalActions(position)).toEqual(getLegalActions(position.state));
      expect(Object.keys(repetitions).length).toBeGreaterThan(0);
      expect(position.eventOffset).toBe(checkpoint.index);
    }
    expect(JSON.stringify(archive)).toBe(before);
  });
}

test("四人・三人・二人生存と外部脱落後の実手番・順位を保持する", async () => {
  let position = await restoreAnalysisPosition({
    ...input(singles.events, 100),
    initial: singles.detail.replay.initial,
  });
  expect(getActiveSides(position.state)).toHaveLength(4);
  expect(position.state.turn).toBe("north");
  position = await advanceAnalysisPosition(position, singles.events[100].event);
  expect(getActiveSides(position.state)).toEqual(["south", "north", "east"]);
  expect(position.state.turn).toBe("north");
  expect(position.state.eliminations[0]).toMatchObject({ side: "west", rank: 4, reason: "left" });
  position = await advanceAnalysisPosition(position, singles.events[101].event);
  expect(getActiveSides(position.state)).toEqual(["south", "north"]);
  expect(position.state.turn).toBe("north");
  expect(position.state.eliminations[1]).toMatchObject({
    side: "east",
    rank: 3,
    reason: "timeout",
  });
  position = await advanceAnalysisPosition(position, singles.events[102].event);
  expect(position.state.status).toBe("finished");
  expect(position.state.result?.reason).toBe("last_player");
  expect(getAnalysisLegalActions(position)).toEqual([]);
});

for (const restricted of [false, true]) {
  test(`三人攻撃${restricted}: 反復直前の基底履歴を復元し、仮の次手で4回目を判定する`, async () => {
    const events = repetitionEvents();
    const position = await restoreAnalysisPosition({
      ...input(events, 31),
      initial: { ...initial, threePlayerAttackProhibited: restricted },
    });
    const before = JSON.stringify(position);
    expect(position.state.status).toBe("playing");
    expect(Math.max(...Object.values(position.state.repetitions))).toBe(3);
    const final = await advanceAnalysisPosition(position, events[31].event);
    expect(final.state.result?.reason).toBe("repetition");
    expect(final.state.turn).toBeNull();
    expect(Math.max(...Object.values(final.state.repetitions))).toBe(4);
    expect(getAnalysisLegalActions(final)).toEqual([]);
    expect(JSON.stringify(position)).toBe(before);
  });
}

test("盤面・手番・手数・直前手が同じでも、基底の反復辞書が違えば別hashになる", async () => {
  const a = await restoreAnalysisPosition(input(repetitionEvents(false), 24));
  const b = await restoreAnalysisPosition(input(repetitionEvents(true), 24));
  const { repetitions: left, ...leftState } = a.state;
  const { repetitions: right, ...rightState } = b.state;
  expect(leftState).toEqual(rightState);
  expect(left).not.toEqual(right);
  expect(a.stateHash).not.toBe(b.stateHash);
  expect(left[positionKey(a.state)]).toBe(3);
});

test("同じ盤面のON/OFFを分け、攻撃履歴で禁止された候補を仮遷移でも拒否する", async () => {
  const on = await restoreAnalysisPosition({
    ...input(singles.events, 49),
    initial: singles.detail.replay.initial,
  });
  const off = await restoreAnalysisPosition({
    ...input(singles.events, 49),
    initial: { ...singles.detail.replay.initial, threePlayerAttackProhibited: false },
  });
  const action = move("C3", "C1", true);
  expect(on.state.board).toEqual(off.state.board);
  expect(on.state.turn).toBe("east");
  expect(off.state.turn).toBe("east");
  expect(on.stateHash).not.toBe(off.stateHash);
  expect(getAnalysisLegalActions(on)).not.toContainEqual(action);
  expect(getAnalysisLegalActions(off)).toContainEqual(action);
  expect(on.state.attackRelations).toContainEqual({
    attacker: "west",
    target: "north",
    reasons: ["threat"],
    targetPieceIds: [20, 24],
    pendingSides: ["south", "east"],
  });
  await expect(
    advanceAnalysisPosition(on, { type: "action", side: "east", action }),
  ).rejects.toThrow("three_player_attack");
  expect(
    (await advanceAnalysisPosition(off, { type: "action", side: "east", action })).eventOffset,
  ).toBe(50);
  const recapture = await restoreAnalysisPosition({
    ...input(singles.events, 62),
    initial: singles.detail.replay.initial,
  });
  expect(recapture.state.recaptureSquares.west).toEqual([{ x: 1, y: 2 }]);
  expect(recapture.state.recaptureSquares.north).toEqual([{ x: 1, y: 2 }]);
});

test("引分提案・取消・同意イベントの位置を着手数と混同せず、反復を増やさない", async () => {
  const start = await restoreAnalysisPosition(input());
  const proposed = await advanceAnalysisPosition(start, {
    type: "drawProposal",
    side: "south",
    proposed: true,
  });
  const cancelled = await advanceAnalysisPosition(proposed, {
    type: "drawProposal",
    side: "south",
    proposed: false,
  });
  expect(proposed.eventOffset).toBe(1);
  expect(cancelled.eventOffset).toBe(2);
  expect(proposed.state.moveNumber).toBe(0);
  expect(proposed.state.drawProposals).toEqual(["south"]);
  expect(proposed.state.repetitions).toEqual(start.state.repetitions);
  expect(proposed.stateHash).not.toBe(start.stateHash);
  expect(cancelled.stateHash).toBe(start.stateHash);
  const full = await restoreAnalysisPosition({
    ...input(draw.events),
    initial: draw.detail.replay.initial,
  });
  expect(full.state.result?.reason).toBe("agreement");
  expect(full.eventOffset).toBe(7);
  expect(full.state.moveNumber).toBe(3);
});

test("入力・保存棋譜・返した状態と合法手を変更せず、JSONの表示状態を解析局面として受け付けない", async () => {
  const source = {
    ...input(singles.events, 1),
    initial: singles.detail.replay.initial,
    events: singles.events,
  };
  const copy = structuredClone(source);
  const position = await restoreAnalysisPosition(copy);
  expect(copy).toEqual(source);
  const before = JSON.stringify(position);
  copy.events[0].event.side = "east";
  const mutableAction = copy.events[0].event.action;
  if (!mutableAction) throw new Error("固定棋譜の先頭は着手です");
  expect(Object.isFrozen(mutableAction.to)).toBe(false);
  mutableAction.to.y = 8;
  expect(JSON.stringify(position)).toBe(before);
  expect(Object.isFrozen(copy)).toBe(false);
  expect(Object.isFrozen(position.state.repetitions)).toBe(true);
  expect(Object.isFrozen(position.state.lastMove!.action.to)).toBe(true);
  const actions = getAnalysisLegalActions(position);
  expect(Object.isFrozen(actions)).toBe(true);
  expect(Object.isFrozen(actions[0].to)).toBe(true);
  expect(() => {
    (position.state.board[0][4] as unknown as { side: string }).side = "south";
  }).toThrow();
  expect(() => getAnalysisLegalActions(structuredClone(position) as AnalysisPosition)).toThrow(
    "解析APIで復元",
  );
  await expect(restoreAnalysisPosition(singles.checkpoints[0].frame.game)).rejects.toThrow(
    AnalysisInputError,
  );
});

test("入力の版・設定・配席・連番・座標・外部脱落理由・offsetを厳密に検証する", async () => {
  const event = { index: 0, event: { type: "action", side: "south", action: move("E7", "E6") } };
  const variants = [
    { ...input(), schemaVersion: 2 },
    { ...input(), rulesVersion: 2 },
    { ...input(), ruleProfileId: "federation-unknown" },
    { ...input(), initial: { ...initial, mode: "doubles" } },
    { ...input(), initial: { mode: "singles", players: initial.players } },
    { ...input(), initial: { ...initial, threePlayerAttackProhibited: "false" } },
    { ...input(), initial: { ...initial, players: { ...initial.players, south: "w" } } },
    input([{ ...event, index: 1 }]),
    input([event, event]),
    input([undefined]),
    input([{ ...event, event: { ...event.event, side: "unknown" } }]),
    input([
      {
        ...event,
        event: { ...event.event, action: { ...event.event.action, to: { x: 0.5, y: 2 } } },
      },
    ]),
    input([{ ...event, event: { type: "eliminate", side: "south", reason: "checkmate" } }]),
    { ...input([event]), eventOffset: -1 },
    { ...input([event]), eventOffset: 2 },
    { ...input([event]), eventOffset: 0.5 },
    { ...input(), unexpected: true },
  ];
  for (const value of variants)
    await expect(restoreAnalysisPosition(value)).rejects.toThrow(AnalysisInputError);
  const illegal = input([{ ...event, event: { ...event.event, side: "west" } }]);
  await expect(restoreAnalysisPosition(illegal)).rejects.toMatchObject({
    code: "event_rejected",
    eventIndex: 0,
  });
  const position = await restoreAnalysisPosition(input());
  const before = JSON.stringify(position);
  await expect(
    advanceAnalysisPosition(position, { type: "eliminate", side: "west", reason: "resigned" }),
  ).rejects.toThrow("not_your_turn");
  expect(JSON.stringify(position)).toBe(before);
});

test("stateHashはJSONキー順と参加者IDに依存せず、独立計算した版1のSHA-256を返す", async () => {
  const start = await restoreAnalysisPosition(input());
  expect(start.stateHash).toBe("7061a8ff86be5ecae851bbc7c89453dab38e1dd9de84bcb0107b82125a801d2c");
  const reordered = await restoreAnalysisPosition({
    ...input(),
    initial: {
      threePlayerAttackProhibited: true,
      players: { east: "E", north: "N", west: "W", south: "S" },
      mode: "singles",
    },
  });
  expect(reordered.stateHash).toBe(start.stateHash);
  expect(reordered.state.players).not.toEqual(start.state.players);
  const off = await restoreAnalysisPosition({
    ...input(),
    initial: { ...initial, threePlayerAttackProhibited: false },
  });
  const threeOn = await advanceAnalysisPosition(start, {
    type: "eliminate",
    side: "west",
    reason: "left",
  });
  const threeOff = await advanceAnalysisPosition(off, {
    type: "eliminate",
    side: "west",
    reason: "left",
  });
  expect(positionKey(threeOn.state)).toBe(positionKey(threeOff.state));
  expect(threeOn.stateHash).not.toBe(threeOff.stateHash);
  expect(off.stateHash).not.toBe(start.stateHash);
});

test("解析識別はコード・解析・モデル版と予算・相手・seedを含め、JSON順序や非JSON値を取り違えない", async () => {
  const start = await restoreAnalysisPosition(input());
  const identity: AnalysisCacheIdentity = {
    codeVersion: "code-1",
    analysisVersion: "analysis-1",
    modelId: null,
    parameters: { budget: { maxWork: 2048 }, opponentModel: "maxn-selfish", seed: 1 },
  };
  const key = await createAnalysisCacheKey(start, identity);
  const reordered = {
    ...identity,
    parameters: { seed: 1, opponentModel: "maxn-selfish", budget: { maxWork: 2048 } },
  };
  expect(await createAnalysisCacheKey(start, reordered)).toBe(key);
  for (const change of [
    { codeVersion: "code-2" },
    { analysisVersion: "analysis-2" },
    { modelId: "model-2" },
    { parameters: { ...identity.parameters, seed: 2 } },
    { parameters: { ...identity.parameters, budget: { maxWork: 4096 } } },
  ])
    expect(await createAnalysisCacheKey(start, { ...identity, ...change })).not.toBe(key);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await expect(
    createAnalysisCacheKey(start, Object.assign([], identity) as unknown as AnalysisCacheIdentity),
  ).rejects.toThrow(AnalysisInputError);
  for (const parameters of [{ work: NaN }, { work: undefined }, cycle, { callback: () => 1 }])
    await expect(
      createAnalysisCacheKey(start, { ...identity, parameters } as AnalysisCacheIdentity),
    ).rejects.toThrow(AnalysisInputError);
});
