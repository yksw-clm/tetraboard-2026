import { expect, test } from "vitest";
import { applyAction, createInitialState, sides } from "@tetraboard/four-shogi";
import {
  formationAction,
  formationCases,
  formationState,
} from "../../../test-fixtures/shogiFormations";
import {
  emptyFormationUsage,
  recordFormationUsage,
  isFormationMatchEligible,
} from "../src/rooms/shogiFormationUsage";

test("全16戦法・4方向の確定着手を局内一度記録し、復元後も重複させない", () => {
  for (const fixture of formationCases)
    for (const side of sides) {
      const before = formationState(
        createInitialState({
          mode: "singles",
          players: { south: "s", west: "w", north: "n", east: "e" },
        }),
        fixture.id,
        side,
        false,
      );
      const result = applyAction(before, side, formationAction(fixture.id, side));
      if (!result.ok) throw new Error(result.reason);
      const source = emptyFormationUsage();
      const used = recordFormationUsage(source, before, result.state, side);
      expect(used.bySide[side]).toEqual([fixture.id]);
      expect(source.bySide[side]).toEqual([]);
      const restored = JSON.parse(JSON.stringify(used));
      expect(recordFormationUsage(restored, before, result.state, side)).toEqual(used);
      expect(recordFormationUsage(used, result.state, result.state, side)).toEqual(used);
      for (const other of sides.filter((entry) => entry !== side))
        expect(used.bySide[other]).toEqual([]);
    }
});

test("同時成立をすべて記録し、既に成立していた戦法・他人・脱落陣営は新規認定しない", () => {
  const initial = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
  });
  const base = formationState(initial, "tenshukaku");
  const after = { ...base, board: base.board.map((row) => [...row]) };
  after.board[7][3] = { id: 100, side: "south", kind: "silver", promoted: false };
  after.board[8][4] = { id: 101, side: "south", kind: "gold", promoted: false };
  const used = recordFormationUsage(emptyFormationUsage(), initial, after, "south");
  expect(used.bySide.south).toEqual(["tenshukaku", "tenshukaku-ship", "batto-silver"]);
  expect(recordFormationUsage(emptyFormationUsage(), after, after, "south").bySide.south).toEqual(
    [],
  );
  expect(recordFormationUsage(emptyFormationUsage(), initial, after, "west").bySide.south).toEqual(
    [],
  );
  const eliminated = {
    ...after,
    eliminations: [{ side: "south" as const, reason: "left" as const, rank: 4, group: 0 }],
  };
  expect(
    recordFormationUsage(emptyFormationUsage(), initial, eliminated, "south").bySide.south,
  ).toEqual([]);
});

test("開始時の対象判定は人間4人のシングルスに限る", () => {
  const participants = sides.map(() => ({ kind: "human" }));
  expect(isFormationMatchEligible({ settings: { mode: "singles" }, participants })).toBe(true);
  expect(isFormationMatchEligible({ settings: { mode: "doubles" }, participants })).toBe(false);
  expect(
    isFormationMatchEligible({
      settings: { mode: "singles" },
      participants: participants.slice(1),
    }),
  ).toBe(false);
  for (const index of [0, 1, 2, 3]) {
    const withCpu = participants.map((p, i) => (i === index ? { kind: "cpu" } : p));
    expect(isFormationMatchEligible({ settings: { mode: "singles" }, participants: withCpu })).toBe(
      false,
    );
  }
});
