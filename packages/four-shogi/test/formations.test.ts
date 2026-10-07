import { expect, test } from "bun:test";
import { applyAction, createInitialState, detectFormations, sides, type Piece } from "../src";
import {
  formationAction,
  formationCases,
  formationSquare,
  formationState,
  type FixtureFormationId,
} from "../../../test-fixtures/shogiFormations";

for (const fixture of formationCases)
  for (const side of sides)
    for (const mode of ["singles", "doubles"] as const) {
      test(`${fixture.name}・${side}・${mode}: 完成の確定着手と根拠座標`, () => {
        const before = formationState(
          createInitialState({
            mode,
            players: { south: "p1", west: "p2", north: "p3", east: "p4" },
          }),
          fixture.id,
          side,
          false,
        );
        expect(detectFormations(before, side)).toEqual([]);
        const result = applyAction(before, side, formationAction(fixture.id, side));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        const frozen = JSON.stringify(result.state);
        const matches = detectFormations(result.state, side);
        const expectedIds: FixtureFormationId[] = ["subway-rook", "lower-gold"].includes(fixture.id)
          ? ["subway-rook", "lower-gold"]
          : [fixture.id];
        expect(matches.map((match) => match.id)).toEqual(expectedIds);
        const match = matches.find((entry) => entry.id === fixture.id)!;
        expect(match).toMatchObject({ id: fixture.id, name: fixture.name });
        expect(match.matchedSquares).toEqual(
          Object.values(fixture.pieces)
            .flat()
            .map((square) => formationSquare(square, side)),
        );
        for (const square of match.matchedSquares)
          expect(result.state.board[square.y][square.x]?.side).toBe(side);
        expect(JSON.stringify(result.state)).toBe(frozen);
      });
    }

for (const fixture of formationCases) {
  test(`${fixture.name}: 必須9枚の欠落・位置・所属・駒種・成りと指定外の駒`, () => {
    const state = formationState(
      createInitialState({
        mode: "singles",
        players: { south: "p1", west: "p2", north: "p3", east: "p4" },
      }),
      fixture.id,
    );
    const required = state.board.flatMap((row, y) =>
      row.flatMap((piece, x) => (piece?.side === "south" ? [{ piece, x, y }] : [])),
    );
    for (const { piece, x, y } of required) {
      for (const replacement of [
        null,
        { ...piece, side: "north" as const },
        { ...piece, kind: piece.kind === "pawn" ? ("gold" as const) : ("pawn" as const) },
        { ...piece, promoted: true },
      ]) {
        const board = state.board.map((row) => [...row]);
        board[y][x] = replacement;
        expect(detectFormations({ ...state, board }, "south")).toEqual([]);
      }
      const board = state.board.map((row) => [...row]);
      board[y][x] = null;
      board[0][0] = piece;
      expect(detectFormations({ ...state, board }, "south")).toEqual([]);
    }
    const board = state.board.map((row) =>
      row.map((piece) => piece && { ...piece, id: piece.id + 100 }),
    );
    board[4][4] = { id: 1000, side: "east", kind: "rook", promoted: true } satisfies Piece;
    board[2][2] = { id: 1001, side: "south", kind: "rook", promoted: true } satisfies Piece;
    const extra = {
      ...state,
      board,
      hands: { ...state.hands, south: { pawn: 5, silver: 2, gold: 2, rook: 1 } },
    };
    expect(detectFormations(extra, "south").map((match) => match.id)).toContain(fixture.id);
    expect(
      detectFormations(
        { ...state, eliminations: [{ side: "south", reason: "timeout", rank: 4, group: 1 }] },
        "south",
      ),
    ).toEqual([]);
    const shifted = Array.from({ length: 9 }, () => Array<Piece | null>(9).fill(null));
    for (const { piece, x, y } of required) shifted[y][(x + 1) % 9] = piece;
    expect(detectFormations({ ...state, board: shifted }, "south")).toEqual([]);
    const reflected = state.board.map((row) => [...row].reverse());
    // 左右対称な形は盤面そのものが同一です。非対称な形だけを反転の否定例にします。
    if (!["tenshukaku", "e-shape", "five"].includes(fixture.id))
      expect(detectFormations({ ...state, board: reflected }, "south")).toEqual([]);
  });
}
test("開始局面に戦型を認定せず、未対応のルール版を黙って解析しない", () => {
  const state = createInitialState({
    mode: "singles",
    players: { south: "1", west: "2", north: "3", east: "4" },
  });
  for (const side of sides) expect(detectFormations(state, side)).toEqual([]);
  expect(() =>
    detectFormations({ ...state, rulesVersion: 2 } as unknown as typeof state, "south"),
  ).toThrow("Unsupported formation rules version");
});
