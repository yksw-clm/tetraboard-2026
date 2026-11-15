import { expect, test } from "vitest";
import { shogiDefinition as definition } from "@tetraboard/shogi/definition";
import {
  chooseCpuAction,
  positionKey,
  type RepetitionEntry,
  type ShogiState,
} from "@tetraboard/shogi";
import { shogiReplayEventSchema, shogiReplayInitialSchema } from "@tetraboard/protocol";
import { getShogiReplayRules } from "../../web/src/features/room/standardShogiReplayV1";
import cpu1 from "../../../test-fixtures/matches/standard-shogi-cpu-1.json";
import cpu4 from "../../../test-fixtures/matches/standard-shogi-cpu-4.json";
import declaration from "../../../test-fixtures/matches/standard-shogi-declaration.json";
import repetition from "../../../test-fixtures/matches/standard-shogi-repetition.json";

for (const [name, fixture] of [
  ["cpu-1", cpu1],
  ["cpu-4", cpu4],
  ["declaration", declaration],
  ["repetition", repetition],
] as const) {
  test(`${name}: 保存初期化情報から契約と既存の棋譜再生の全イベント・最終結果が一致する`, () => {
    const initial = shogiReplayInitialSchema.parse(fixture.detail.replay.initial);
    const events = fixture.events.map((e) => shogiReplayEventSchema.parse(e));
    const frames = definition.replay(initial, events);
    const old = getShogiReplayRules(fixture.detail.replay.rulesVersion);
    let state = old.initialize(initial);
    let sparse: ShogiState = { ...state, repetitions: {} };
    const history = new Map<string, RepetitionEntry>(Object.entries(state.repetitions));
    for (const [index, event] of events.entries()) {
      const expected = old.applyEvent(state, event);
      const actual =
        event.type === "eliminate"
          ? {
              ok: true as const,
              ...definition.rules.eliminateSeat(sparse, event.side, event.reason),
            }
          : definition.rules.applyAction(
              sparse,
              event.side,
              event.type === "action" ? event.action : event,
              (key) => history.get(key),
            );
      if (!expected.ok || !actual.ok) throw new Error("Invalid fixture");
      state = expected.state;
      expect(frames[index]).toEqual(state);
      expect(old.createFrame(state).game).toEqual(old.createFrame(frames[index]).game);
      for (const [key, entry] of Object.entries(actual.state.repetitions)) history.set(key, entry);
      sparse = { ...actual.state, repetitions: {} };
      expect(old.createFrame(sparse).game).toEqual(old.createFrame(state).game);
    }
    expect(frames).toHaveLength(fixture.detail.replay.eventCount);
    expect(old.createFrame(state).game).toEqual(fixture.detail.game);
    expect(definition.rules.getResult(frames.at(-1)!)).toEqual(fixture.detail.game.result);
    if (name === "repetition")
      expect(Math.max(...Object.values(state.repetitions).map((e) => e.count))).toBe(4);
  });

  test(`${name}: CPUの固定乱数を再現して保存された全着手を再現できる`, () => {
    const saved = fixture.detail.generation;
    let value = "seed" in saved ? saved.seed : 0;
    let draws = 0;
    const random = () =>
      "randomValues" in saved
        ? saved.randomValues[draws++]
        : (value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 4294967296;
    const old = getShogiReplayRules(1);
    let state = old.initialize(fixture.detail.replay.initial);
    for (const raw of fixture.events) {
      const event = shogiReplayEventSchema.parse(raw);
      if (event.type === "action") expect(chooseCpuAction(state, 1, random)).toEqual(event.action);
      const result = old.applyEvent(state, event);
      if (!result.ok) throw new Error("Invalid fixture event");
      state = result.state;
    }
  });
}

test("固定棋譜は駒打ち・成り・手番外の提案と取消・宣言・千日手を含む", () => {
  const events = [...cpu1.events, ...cpu4.events, ...declaration.events, ...repetition.events].map(
    (e) => shogiReplayEventSchema.parse(e),
  );
  expect(events.some((e) => e.type === "action" && e.action.type === "dropPiece")).toBe(true);
  expect(
    events.some((e) => e.type === "action" && e.action.type === "movePiece" && e.action.promote),
  ).toBe(true);
  expect(events.some((e) => e.type === "declaration")).toBe(true);
  const frames = definition.replay(
    cpu4.detail.replay.initial,
    cpu4.events.map((e) => shogiReplayEventSchema.parse(e)),
  );
  for (const [i, raw] of cpu4.events.entries()) {
    const event = shogiReplayEventSchema.parse(raw);
    if (event.type !== "drawProposal") continue;
    expect(event.side).not.toBe(frames[i - 1].turn);
    expect(positionKey(frames[i])).toBe(positionKey(frames[i - 1]));
    expect(frames[i].moveNumber).toBe(frames[i - 1].moveNumber);
  }
  expect(cpu4.events.filter((e) => e.type === "drawProposal").map((e) => e.proposed)).toEqual([
    true,
    false,
  ]);
  expect(repetition.detail.game.result.reason).toBe("repetition");
});
