import { expect, test } from "bun:test";
import { createInitialState, getActiveSides, type Side } from "../src/index";
import {
  advanceAnalysisPosition,
  createAnalysisCacheKey,
  createAnalysisSetupPosition,
  getAnalysisLegalActions,
  validateAnalysisSetup,
  type AnalysisSetupInput,
} from "../src/analysis";

function setup(eliminations: AnalysisSetupInput["eliminations"] = []): AnalysisSetupInput {
  const initial = createInitialState({
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
  });
  return {
    schemaVersion: 1,
    board: initial.board.map((row) =>
      row.map((piece) =>
        piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
      ),
    ),
    hands: initial.hands,
    turn: "south",
    threePlayerAttackProhibited: true,
    eliminations,
  };
}
for (const eliminated of [
  [],
  [{ side: "west" as const, rank: 4, group: 1 }],
  [
    { side: "west" as const, rank: 4, group: 1 },
    { side: "east" as const, rank: 3, group: 2 },
  ],
  [
    { side: "west" as const, rank: 3, group: 1 },
    { side: "east" as const, rank: 3, group: 1 },
  ],
]) {
  test(`自由編集: ${4 - eliminated.length}人生存・${eliminated.map((e) => e.rank)}位で完全状態を新規作成する`, async () => {
    const input = setup(eliminated);
    const before = JSON.stringify(input);
    const position = await createAnalysisSetupPosition(input);
    expect(getActiveSides(position.state)).toHaveLength(4 - eliminated.length);
    expect(position.eventOffset).toBe(0);
    expect(position.state.attackRelations).toEqual([]);
    expect(position.state.drawProposals).toEqual([]);
    expect(position.state.lastMove).toBeNull();
    expect(Object.values(position.state.repetitions)).toEqual([1]);
    expect(Object.isFrozen(position.state.board)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    const [action] = getAnalysisLegalActions(position);
    const next = await advanceAnalysisPosition(position, { type: "action", side: "south", action });
    expect(next.eventOffset).toBe(1);
    expect(position.state.moveNumber).toBe(0);
    expect(
      await createAnalysisCacheKey(position, {
        codeVersion: "test",
        analysisVersion: "test",
        modelId: null,
        parameters: {},
      }),
    ).toHaveLength(64);
  });
}

test("自由編集: 不整合な脱落順・同時順位、脱落者の手番を拒否する", () => {
  for (const eliminations of [
    [{ side: "west" as const, rank: 3, group: 1 }],
    [{ side: "west" as const, rank: 4, group: 2 }],
    [
      { side: "west" as const, rank: 4, group: 1 },
      { side: "east" as const, rank: 3, group: 1 },
    ],
    [{ side: "south" as const, rank: 4, group: 1 }],
    [
      { side: "west" as const, rank: 4, group: 1 },
      { side: "west" as const, rank: 3, group: 2 },
    ],
  ])
    expect(() => validateAnalysisSetup(setup(eliminations))).toThrow();
});

test("自由編集: 王・成り・駒総数・二歩・行き所・脱落者の持ち駒を検証する", () => {
  const input = setup();
  const withoutKing = input.board.map((row) =>
    row.map((piece) => (piece?.side === "south" && piece.kind === "king" ? null : piece)),
  );
  expect(() => validateAnalysisSetup({ ...input, board: withoutKing })).toThrow("玉");
  const promotedKing = input.board.map((row) =>
    row.map((piece) => (piece?.kind === "king" ? { ...piece, promoted: true } : piece)),
  );
  expect(() => validateAnalysisSetup({ ...input, board: promotedKing })).toThrow("成り");
  expect(() =>
    validateAnalysisSetup({
      ...input,
      hands: { ...input.hands, south: { ...input.hands.south, rook: 1 } },
    }),
  ).toThrow("合計");
  const nifu = input.board.map((row) => [...row]);
  nifu[6][3] = { side: "south", kind: "pawn", promoted: false };
  expect(() => validateAnalysisSetup({ ...input, board: nifu })).toThrow("二歩");
  nifu[6][3] = null;
  nifu[0][0] = { side: "south", kind: "pawn", promoted: false };
  expect(() => validateAnalysisSetup({ ...input, board: nifu })).toThrow("行き所");
  expect(() =>
    validateAnalysisSetup({
      ...setup([{ side: "west", rank: 4, group: 1 }]),
      hands: { ...input.hands, west: { ...input.hands.west, pawn: 1 } },
    }),
  ).toThrow("脱落者");
});

test("自由編集: 王手中の実手番を検査し、外部の履歴を注入させない", async () => {
  const input = setup();
  const board = input.board.map((row) =>
    row.map((piece) => (piece?.kind === "king" ? piece : null)),
  );
  board[7][0] = { side: "south", kind: "rook", promoted: false };
  expect(() => validateAnalysisSetup({ ...input, board })).toThrow("王手");
  const position = await createAnalysisSetupPosition({
    ...input,
    board,
    turn: "west" satisfies Side,
  });
  expect(position.state.turn).toBe("west");
  expect(getAnalysisLegalActions(position).length).toBeGreaterThan(0);
  expect(() => validateAnalysisSetup({ ...input, repetitions: { forged: 3 } })).toThrow();
});

test("自由編集: 生存する玉同士の隣接を拒否し、裏王には同じ制限を付けない", () => {
  const input = setup();
  const board = input.board.map((row) =>
    row.map((piece) => (piece?.kind === "king" ? piece : null)),
  );
  const westKing = board.flat().find((piece) => piece?.side === "west")!;
  for (const row of board)
    for (let x = 0; x < row.length; x++) if (row[x]?.side === "west") row[x] = null;
  board[8][3] = westKing;
  expect(() => validateAnalysisSetup({ ...input, board })).toThrow("玉同士");
  expect(() =>
    validateAnalysisSetup({ ...input, board, eliminations: [{ side: "west", rank: 4, group: 1 }] }),
  ).not.toThrow();
});
