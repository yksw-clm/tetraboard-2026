import { expect, test } from "bun:test";
import { defineGame, type EliminationReason, type GameDefinition } from "@tetraboard/game-contract";

interface ExampleTypes {
  state: number;
  seat: "player";
  action: { amount: number };
  event: { amount: number } | { reason: EliminationReason };
  settings: { initial: number };
  result: { total: number };
  rejection: "negative_amount";
  cpuLevel: 1;
}

const definition = defineGame<ExampleTypes, "example">({
  catalog: {
    id: "example",
    seats: ["player"],
    rating: "none",
    defaultSettings: { initial: 0 },
  },
  rules: {
    createInitialState: ({ initial }) => initial,
    getTurn: (state) => (state >= 2 ? null : "player"),
    applyAction: (state, _seat, action) =>
      action.amount < 0
        ? { ok: false, reason: "negative_amount" }
        : { ok: true, state: state + action.amount, event: action },
    eliminateSeat: (state, _seat, reason) => ({ state, event: { reason } }),
    getResult: (state) => (state >= 2 ? { total: state } : null),
  },
  cpu: { chooseAction: (_state, _seat, _level, random) => ({ amount: random() < 0.5 ? 1 : 2 }) },
  replay: (initial, events) => {
    let state = initial;
    return events.map((event) => (state += "amount" in event ? event.amount : 0));
  },
});

test("型の組からカタログ・ルール・CPU・棋譜の型を対応付ける", () => {
  const game: GameDefinition<ExampleTypes, "example"> = definition;
  const id: "example" = game.catalog.id;
  expect(id).toBe("example");
  expect(game.rules.createInitialState(game.catalog.defaultSettings)).toBe(0);
  expect(game.rules.getTurn(0)).toBe("player");
  expect(game.rules.getTurn(2)).toBeNull();
  const result = game.rules.applyAction(0, "player", { amount: 2 });
  expect(result).toEqual({ ok: true, state: 2, event: { amount: 2 } });
  if (!result.ok) throw new Error("Expected accepted action");
  expect(game.replay(0, [result.event])).toEqual([2]);
  expect(game.rules.getResult(result.state)).toEqual({ total: 2 });
  expect(game.rules.applyAction(0, "player", { amount: -1 })).toEqual({
    ok: false,
    reason: "negative_amount",
  });
  expect(game.rules.eliminateSeat(0, "player", "left").event).toEqual({ reason: "left" });
  expect(game.cpu.chooseAction(0, "player", 1, () => 0.75)).toEqual({ amount: 2 });
});
