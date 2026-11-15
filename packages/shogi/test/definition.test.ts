import { expect, test } from "bun:test";
import {
  shogiDefinition as game,
  usiMove,
  type ShogiGameAction,
  type ShogiEvent,
} from "../src/definition";
import { shogiCatalog } from "../src/catalog";
import {
  applyAction,
  createInitialState,
  chooseCpuAction,
  declareEnteringKing,
  declarationStatus,
  eliminateSide,
  getLegalActions,
  setDrawProposal,
  otherSide,
  positionKey,
  type ShogiState,
  type Side,
  type RepetitionEntry,
  type ShogiAction,
} from "../src";
import { recordPosition } from "../src/repetition";
import { position } from "./fixtures";

const initial = { players: { south: "cpu-south", north: "cpu-north" } };
function entering(points = 31): ShogiState {
  const state = position();
  const board = state.board.map((row) =>
    row.map(() => null),
  ) as ShogiState["board"][number][number][][];
  board[1][4] = { id: 1, side: "south", kind: "king", promoted: false };
  board[8][8] = { id: 2, side: "north", kind: "king", promoted: false };
  for (let i = 0; i < 10; i++)
    board[Math.floor(i / 9)][i % 9] = { id: i + 3, side: "south", kind: "gold", promoted: false };
  return {
    ...state,
    board,
    hands: {
      ...state.hands,
      south: { ...state.hands.south, pawn: points - 10 },
      north: { ...state.hands.north, pawn: 24 },
    },
  };
}
function matches(state: ShogiState, side: Side, action: ShogiGameAction) {
  const before = structuredClone(state);
  const expected =
    action.type === "declaration"
      ? declareEnteringKing(state, side)
      : action.type === "drawProposal"
        ? setDrawProposal(state, side, action.proposed)
        : applyAction(state, side, action);
  const actual = game.rules.applyAction(state, side, action);
  expect(actual.ok).toBe(expected.ok);
  if (actual.ok && expected.ok) expect(actual.state).toEqual(expected.state);
  else if (!actual.ok && !expected.ok) expect(actual.reason).toEqual({ type: expected.reason });
  else throw new Error("Mismatched acceptance");
  expect(state).toEqual(before);
  return actual;
}

test("カタログ・初期化・結果は既存の席とEloを保つ", () => {
  expect(game.catalog).toBe(shogiCatalog);
  expect(game.catalog.seats).toEqual(["south", "north"]);
  expect(game.catalog.rating).toBe("elo");
  const state = game.rules.createInitialState(initial);
  expect(state).toEqual(createInitialState(initial));
  expect(game.rules.getTurn(state)).toBe("south");
  expect(game.rules.getResult(state)).toBeNull();
  expect(game.replay(initial, [])).toEqual([]);
});

test("着手・駒打ち・不正着手・手番外の拒否が既存と一致する", () => {
  const state = createInitialState(initial);
  const move: ShogiAction = {
    type: "movePiece",
    from: { x: 2, y: 6 },
    to: { x: 2, y: 5 },
    promote: false,
  };
  const result = matches(state, "south", move);
  expect(result.ok && result.event).toEqual({ type: "action", side: "south", action: move });
  matches(state, "north", move);
  matches(state, "south", { ...move, to: { x: -1, y: 0 } });
  matches(state, "south", { type: "dropPiece", pieceKind: "pawn", to: { x: 2, y: 4 } });
  const drop: ShogiAction = { type: "dropPiece", pieceKind: "silver", to: { x: 2, y: 4 } };
  const held = { ...state, hands: { ...state.hands, south: { ...state.hands.south, silver: 1 } } };
  const dropped = matches(held, "south", drop);
  expect(dropped.ok && dropped.event).toEqual({ type: "action", side: "south", action: drop });
  expect(dropped.ok && dropped.state.hands.south.silver).toBe(0);
  matches(held, "north", drop);
});

test("持将棋提案は手番を不要とし、提案・取消・同意でも手番を終えない", () => {
  const state = entering(24);
  const proposal: ShogiGameAction = { type: "drawProposal", proposed: true };
  expect(game.rules.requiresTurn?.(proposal)).toBe(false);
  expect(game.rules.endsTurn?.(proposal)).toBe(false);
  const first = matches(state, "north", proposal);
  if (!first.ok) throw new Error("Expected proposal");
  expect(first.event).toEqual({ type: "drawProposal", side: "north", proposed: true });
  expect(first.state.turn).toBe(state.turn);
  expect(first.state.moveNumber).toBe(state.moveNumber);
  expect(first.state.repetitions).toEqual(state.repetitions);
  matches(first.state, "north", { type: "drawProposal", proposed: false });
  const agreed = matches(first.state, "south", proposal);
  expect(agreed.ok && agreed.state.result).toEqual({ winner: null, reason: "impasse" });
  matches(createInitialState(initial), "north", proposal);
  expect(game.rules.applyAction(first.state, "north", proposal).ok).toBe(true);
});

test("入玉宣言の勝利・引分・不成立・手番外と終局後の拒否が一致する", () => {
  for (const points of [23, 24, 30, 31]) {
    const state = entering(points);
    const action: ShogiGameAction = { type: "declaration" };
    expect(game.rules.requiresTurn?.(action)).toBe(true);
    expect(game.rules.endsTurn?.(action)).toBe(false);
    const result = matches(state, "south", action);
    matches(state, "north", action);
    if (!result.ok) throw new Error("Expected declaration");
    expect(result.event).toEqual({ type: "declaration", side: "south" });
    expect(game.rules.getTurn(result.state)).toBeNull();
    expect(game.rules.getResult(result.state)).toEqual(result.state.result);
    matches(result.state, "south", action);
  }
});

test("投了・外部脱落のイベントと状態は既存と一致する", () => {
  for (const reason of ["resigned", "left", "timeout", "disconnected"] as const) {
    const state = createInitialState(initial);
    const expected = eliminateSide(state, "south", reason);
    if (!expected.ok) throw new Error("Expected elimination");
    const actual = game.rules.eliminateSeat(state, "south", reason);
    expect(actual).toEqual({
      state: expected.state,
      event: { type: "eliminate", side: "south", reason },
    });
    expect(game.replay(initial, [actual.event])).toEqual([expected.state]);
    expect(() => game.rules.eliminateSeat(actual.state, "north", reason)).toThrow();
  }
  expect(() =>
    game.rules.eliminateSeat(createInitialState(initial), "north", "resigned"),
  ).toThrow();
});

test("SQLite相当の履歴関数で千日手と連続王手を完全履歴と同じように数える", () => {
  const rook = { id: 3, kind: "rook" as const, side: "south" as const, promoted: false };
  const ordinary: ShogiAction[] = [
    { type: "movePiece", from: { x: 4, y: 8 }, to: { x: 5, y: 8 }, promote: false },
    { type: "movePiece", from: { x: 4, y: 0 }, to: { x: 5, y: 0 }, promote: false },
    { type: "movePiece", from: { x: 5, y: 8 }, to: { x: 4, y: 8 }, promote: false },
    { type: "movePiece", from: { x: 5, y: 0 }, to: { x: 4, y: 0 }, promote: false },
  ];
  const checking = [
    { ...ordinary[0], from: { x: 5, y: 2 }, to: { x: 4, y: 2 } },
    ordinary[1],
    { ...ordinary[0], from: { x: 4, y: 2 }, to: { x: 5, y: 2 } },
    ordinary[3],
  ] as ShogiAction[];
  for (const [start, actions, reason] of [
    [position(), ordinary, "repetition"],
    [position([[5, 2, rook]]), checking, "perpetual_check"],
  ] as const) {
    let full = recordPosition({ ...start, repetitions: {} });
    let sparse = { ...full, repetitions: {} };
    const entries = new Map<string, RepetitionEntry>(Object.entries(full.repetitions));
    let lookups = 0;
    const history = (key: string) => {
      lookups++;
      return entries.get(key);
    };
    for (let i = 0; i < 12; i++) {
      if (full.status !== "playing" || sparse.status !== "playing") throw new Error("Early finish");
      const before = [...entries];
      const expected = applyAction(full, full.turn, actions[i % 4]);
      const actual = game.rules.applyAction(sparse, sparse.turn, actions[i % 4], history);
      expect([...entries]).toEqual(before);
      if (!expected.ok || !actual.ok) throw new Error("Expected legal cycle");
      full = expected.state;
      for (const [key, value] of Object.entries(actual.state.repetitions)) entries.set(key, value);
      sparse = { ...actual.state, repetitions: {} };
      const { repetitions: _index, ...core } = full;
      expect(sparse).toEqual({ ...core, repetitions: {} });
    }
    expect(lookups).toBeGreaterThan(0);
    expect(sparse.result?.reason).toBe(reason);
  }
});

test.each([1, 2] as const)(
  "CPU Lv%i は同じ乱数・履歴で既存の手を選び、勝てる宣言を優先する",
  (level) => {
    for (const state of [createInitialState(initial), entering(24)]) {
      const history = () => undefined;
      if (state.status !== "playing") throw new Error("Expected playing");
      const before = structuredClone(state);
      expect(game.cpu.chooseAction(state, state.turn, level, () => 0.75, history)).toEqual(
        chooseCpuAction(state, level, () => 0.75, history),
      );
      expect(
        game.cpu.chooseAction(state, otherSide(state.turn), level, () => 0.75, history),
      ).toBeNull();
      expect(state).toEqual(before);
    }
    const winning = entering();
    expect(declarationStatus(winning, "south").outcome).toBe("win");
    expect(game.cpu.chooseAction(winning, "south", level, () => 0)).toEqual({
      type: "declaration",
    });
    const finished = game.rules.eliminateSeat(winning, "south", "resigned").state;
    expect(game.cpu.chooseAction(finished, "south", level, () => 0)).toBeNull();
  },
);

test("USI の通常手・成り・全持駒の打ちを読み、合法手を既存と同じように照合する", () => {
  const external = game.cpu.external!;
  const state = createInitialState(initial);
  for (const action of getLegalActions(state))
    expect(external.readMove(usiMove(action))).toEqual(action);
  for (const pieceKind of [
    "rook",
    "bishop",
    "gold",
    "silver",
    "knight",
    "lance",
    "pawn",
  ] as const) {
    const action: ShogiAction = { type: "dropPiece", pieceKind, to: { x: 3, y: 4 } };
    expect(external.readMove(usiMove(action))).toEqual(action);
  }
  const promotion: ShogiAction = {
    type: "movePiece",
    from: { x: 1, y: 3 },
    to: { x: 2, y: 2 },
    promote: true,
  };
  expect(external.readMove(usiMove(promotion))).toEqual(promotion);
  for (const text of ["resign", "win", "7g7z", "0a1b", "K*5e", "P*5e+", "7g7f "])
    expect(external.readMove(text)).toBeNull();
  const illegal = external.readMove("7g7a")!;
  expect(game.rules.applyAction(state, "south", illegal).ok).toBe(false);
  expect(external.getPositionKey(state)).toBe(external.getPositionKey(structuredClone(state)));
  expect(external.getPositionKey(state)).not.toBe(
    external.getPositionKey({ ...state, drawProposals: ["north"] }),
  );
  expect(external.getPositionKey(state)).not.toBe(
    external.getPositionKey({ ...state, moveNumber: 1 }),
  );
  expect(external.fallbackAction).toBeUndefined();
  expect(positionKey(state)).toBe(positionKey({ ...state, drawProposals: ["north"] }));
});

test("要求本文はプロファイルの有無と定跡の境界を含め従来どおり", () => {
  const state = createInitialState(initial);
  for (const moves of [[], ["7g7f"], ["7g7f", "3c3d"]])
    for (const profile of [{}, { nodes: 8192, standardBook: true }]) {
      const request = game.cpu.external!.createRequest(state, "south", 2, { moves, ...profile });
      expect(request).toEqual({
        nodes: profile.nodes ?? 256,
        moves,
        ...(profile.standardBook && moves.length < 2 ? { opening_book: "standard-v1" } : {}),
      });
    }
});

test("再生は不正な手・手番・終局後のイベントを拒否する", () => {
  const state = createInitialState(initial);
  const action = getLegalActions(state)[0];
  const event: ShogiEvent = { type: "action", side: "north", action };
  expect(() => game.replay(initial, [event])).toThrow();
  expect(() =>
    game.replay(initial, [{ ...event, side: "south", action: { ...action, to: { x: -1, y: 0 } } }]),
  ).toThrow();
  expect(() =>
    game.replay(initial, [
      { type: "eliminate", side: "south", reason: "left" },
      { ...event, side: "south" },
    ]),
  ).toThrow();
});

test("CPU Lv2 は履歴関数の値を探索へ渡し、基底履歴へ書き込まない", () => {
  const initialState = createInitialState(initial);
  const state: ShogiState = { ...initialState, repetitions: {} };
  const entries = new Map<string, RepetitionEntry>();
  for (const action of getLegalActions(state)) {
    const result = applyAction(state, "south", action);
    if (!result.ok) throw new Error("Expected candidate");
    entries.set(positionKey(result.state), { count: 3, nonChecks: { south: 0, north: 0 } });
  }
  const before = [...entries];
  let calls = 0;
  const history = (key: string) => {
    calls++;
    return entries.get(key);
  };
  const expected = chooseCpuAction(
    state,
    2,
    () => 0.5,
    (key) => entries.get(key),
  );
  expect(game.cpu.chooseAction(state, "south", 2, () => 0.5, history)).toEqual(expected);
  expect(calls).toBeGreaterThan(0);
  expect([...entries]).toEqual(before);
  expect(state.repetitions).toEqual({});
});
