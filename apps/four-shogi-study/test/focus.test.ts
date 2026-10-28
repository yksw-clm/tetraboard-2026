import { expect, test } from "bun:test";
import {
  applyAction,
  getActiveSides,
  getCheckState,
  type FourShogiState,
  type Side,
} from "@tetraboard/four-shogi";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { positionForSide } from "../../../packages/four-shogi/src/board";
import { sides } from "../../../packages/four-shogi/src/types";
import { restoreStudyPosition } from "../src/domain/study";
import { projectFocusPosition, type FocusProjection } from "../src/search/focus";

async function setup(state: FourShogiState) {
  return restoreStudyPosition({
    origin: {
      kind: "setup",
      setup: {
        schemaVersion: 1,
        board: state.board.map((row) =>
          row.map((piece) =>
            piece ? { side: piece.side, kind: piece.kind, promoted: piece.promoted } : null,
          ),
        ),
        hands: state.hands,
        turn: state.turn!,
        threePlayerAttackProhibited: state.threePlayerAttackProhibited,
        eliminations: state.eliminations.map((entry) => ({
          side: entry.side,
          rank: entry.rank!,
          group: entry.group,
        })),
      },
    },
    events: [],
  });
}

async function replayPrefix(source: AnalysisPosition, projection: FocusProjection) {
  let current = source;
  for (const [index, step] of projection.prefix.entries()) {
    expect(step.side).toBe(current.state.turn!);
    expect(step.afterPly).toBe(index + 1);
    expect(getAnalysisLegalActions(current)).toContainEqual(step.action);
    const applied = applyAction(current.state, step.side, step.action);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("予測prefixが正本で拒否されました");
    const checks = getCheckState(applied.state);
    expect(step).toMatchObject({
      nextTurn: applied.state.turn,
      checkedSides: getActiveSides(applied.state).filter((side) => checks[side]),
      captured: applied.captured,
      eliminations: applied.eliminations,
      result: applied.state.result,
    });
    current = await advanceAnalysisPosition(current, {
      type: "action",
      side: step.side,
      action: step.action,
    });
  }
  if (projection.status === "ready") {
    expect(projection.analysisStateHash).toBe(current.stateHash);
    expect(projection.position).toEqual(current);
    expect(getAnalysisLegalActions(projection.position!)).toEqual(getAnalysisLegalActions(current));
  } else {
    expect(projection.analysisStateHash).toBeNull();
    expect(projection.position).toBeNull();
  }
  return current;
}

test("フォーカス本人の手番は予測せず同じtrusted局面を返し、複製状態を拒否する", async () => {
  const position = await setup(fixture());
  const result = await projectFocusPosition(position, "south", { timeBudgetMs: 0 });
  expect(result).toMatchObject({
    status: "ready",
    sourceStateHash: position.stateHash,
    analysisStateHash: position.stateHash,
    prefix: [],
    model: { work: 0, decisions: [] },
  });
  expect(result.position).toBe(position);
  await expect(projectFocusPosition(structuredClone(position), "south")).rejects.toThrow(
    "解析APIで復元した局面",
  );
});

test("他席を各人自身の利得で予測し、指定席の最初の実手番で止める", async () => {
  const position = await setup(
    fixture({
      pieces: [
        { side: "south", kind: "silver", at: "E5" },
        { side: "west", kind: "rook", at: "F4" },
      ],
    }),
  );
  const before = JSON.stringify(position);
  const result = await projectFocusPosition(position, "east", { timeBudgetMs: null });
  expect(result.status).toBe("ready");
  expect(result.prefix.map((step) => step.side)).toEqual(["south", "west", "north"]);
  expect(result.prefix[0].captured?.kind).toBe("rook");
  expect(result.position?.state.turn).toBe("east");
  expect(result.analysisStateHash).not.toBe(position.stateHash);
  expect(result.model).toMatchObject({
    version: "local-focus-projection-v1",
    opponentModelId: "selfish-maxn-v1",
    maxPlies: 12,
    workPerPly: 256,
  });
  expect(result.model.decisions.every((entry) => entry.work <= 256)).toBe(true);
  expect(result.model.work).toBe(
    result.model.decisions.reduce((sum, entry) => sum + entry.work, 0),
  );
  await replayPrefix(position, result);
  expect(JSON.stringify(position)).toBe(before);
});

test("四方向とON/OFFでマジックの王手による手番飛ばしを保つ", async () => {
  const base = fixture({
    kings: { south: "A8", east: "C8" },
    pieces: [
      { side: "south", kind: "rook", at: "E3" },
      { side: "west", kind: "gold", at: "C3" },
      { side: "north", kind: "silver", at: "B4" },
    ],
  });
  for (const restricted of [false, true])
    for (const [offset, orientation] of sides.entries()) {
      const rotateSide = (side: Side) => sides[(sides.indexOf(side) + offset) % 4];
      const board = base.board.map((row) =>
        row.map(() => null),
      ) as FourShogiState["board"][number][number][][];
      for (let y = 0; y < 9; y++)
        for (let x = 0; x < 9; x++) {
          const to = positionForSide({ x, y }, orientation);
          const piece = base.board[y][x];
          board[to.y][to.x] = piece ? { ...piece, side: rotateSide(piece.side) } : null;
        }
      const position = await setup({
        ...base,
        status: "playing",
        result: null,
        board,
        turn: rotateSide("south"),
        threePlayerAttackProhibited: restricted,
      });
      const focus = rotateSide("east");
      const result = await projectFocusPosition(position, focus, {
        timeBudgetMs: null,
        workPerPly: 4096,
      });
      expect(result.status).toBe("ready");
      expect(result.prefix).toHaveLength(1);
      expect(result.prefix[0]).toMatchObject({
        side: rotateSide("south"),
        nextTurn: focus,
        checkedSides: [focus],
        captured: { kind: "gold" },
      });
      expect(result.position?.state.turn).toBe(focus);
      await replayPrefix(position, result);
    }
});

test("予測中のフォーカス脱落と、初めからの脱落や終局を明示する", async () => {
  const tactic = tacticalCases().find((entry) => entry.id === "last-opponent-false-south")!;
  const position = await setup(tactic.state);
  const already = await projectFocusPosition(position, "north", { timeBudgetMs: null });
  expect(already).toMatchObject({
    status: "focus_eliminated",
    prefix: [],
    position: null,
    analysisStateHash: null,
  });
  const eliminated = await projectFocusPosition(position, "west", {
    timeBudgetMs: null,
    workPerPly: 4096,
  });
  expect(eliminated.status).toBe("focus_eliminated");
  expect(eliminated.prefix).toHaveLength(1);
  expect(eliminated.prefix[0].eliminations.some((entry) => entry.side === "west")).toBe(true);
  expect(eliminated.result?.reason).toBe("last_player");
  const terminal = await replayPrefix(position, eliminated);
  const finished = await projectFocusPosition(terminal, "south", { timeBudgetMs: null });
  expect(finished).toMatchObject({
    status: "terminal",
    prefix: [],
    position: null,
    analysisStateHash: null,
  });
  expect(finished.result?.reason).toBe("last_player");
});

test("元棋譜の反復履歴を保ち、予測手で成立する千日手を終局として返す", async () => {
  let position = await setup(fixture());
  let source: AnalysisPosition | null = null;
  let expected: AnalysisPosition | null = null;
  for (let ply = 0; ply < 128 && position.state.status === "playing"; ply++) {
    const action = getAnalysisLegalActions(position)[0];
    const next = await advanceAnalysisPosition(position, {
      type: "action",
      side: position.state.turn,
      action,
    });
    if (next.state.result?.reason === "repetition") {
      source = position;
      expected = next;
      break;
    }
    position = next;
  }
  if (!source || !expected) throw new Error("固定の合法手列が千日手へ到達しませんでした");
  const focus = getActiveSides(source.state).find((side) => side !== source!.state.turn)!;
  const before = JSON.stringify(source);
  const result = await projectFocusPosition(source, focus, { timeBudgetMs: null, workPerPly: 1 });
  expect(result.status).toBe("terminal");
  expect(result.prefix).toHaveLength(1);
  expect(result.result?.reason).toBe("repetition");
  expect(result.model.decisions[0].fallback).toBe(true);
  expect((await replayPrefix(source, result)).stateHash).toBe(expected.stateHash);
  expect(JSON.stringify(source)).toBe(before);
});

test("手数・時間上限や取消で未到達の将来手を解析対象にしない", async () => {
  const position = await setup(fixture());
  const limited = await projectFocusPosition(position, "east", {
    maxPlies: 1,
    timeBudgetMs: null,
    workPerPly: 1,
  });
  expect(limited).toMatchObject({
    status: "unreached",
    reason: "ply_limit",
    position: null,
    analysisStateHash: null,
  });
  expect(limited.prefix).toHaveLength(1);
  await replayPrefix(position, limited);
  expect(await projectFocusPosition(position, "east", { timeBudgetMs: 0 })).toMatchObject({
    status: "unreached",
    reason: "deadline",
    prefix: [],
    position: null,
  });
  const controller = new AbortController();
  controller.abort();
  expect(
    await projectFocusPosition(position, "south", {}, { signal: controller.signal }),
  ).toMatchObject({ status: "cancelled", reason: "cancelled", prefix: [], position: null });
  const during = new AbortController();
  const cancelled = await projectFocusPosition(
    position,
    "east",
    { timeBudgetMs: null, workPerPly: 4096 },
    {
      signal: during.signal,
      yieldToHost: async () => {
        during.abort();
      },
    },
  );
  expect(cancelled).toMatchObject({
    status: "cancelled",
    reason: "cancelled",
    position: null,
    analysisStateHash: null,
  });
  expect(cancelled.prefix.length).toBeLessThan(3);
  await replayPrefix(position, cancelled);
});

test("予測条件の不正値と非単調時計を拒否する", async () => {
  const position = await setup(fixture());
  for (const options of [
    { maxPlies: -1 },
    { maxPlies: 65 },
    { workPerPly: 0 },
    { workPerPly: 4097 },
    { timeBudgetMs: -1 },
    { timeBudgetMs: Infinity },
  ])
    await expect(projectFocusPosition(position, "east", options)).rejects.toThrow("予測は");
  let time = 2;
  await expect(projectFocusPosition(position, "east", {}, { now: () => time-- })).rejects.toThrow(
    "時計は単調",
  );
});
