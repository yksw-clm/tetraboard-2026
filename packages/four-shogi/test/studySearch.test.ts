import { expect, test } from "bun:test";
import {
  createAnalysisSetupPosition,
  restoreAnalysisPosition,
  type AnalysisPosition,
  type AnalysisSetupInput,
} from "../src/analysis";
import {
  createStudyRootSearch,
  compareStudyCandidates,
  selectStudyRootIndices,
  evaluateStudyPosition,
  studyRightSide,
  type StudyCandidate,
} from "../src/studySearch";
import { applyAction, getLegalActions } from "../src/index";
import type { FourShogiState } from "../src/types";
import { fixture as positionFixture } from "../bench/positionFixture";
import { tacticalCases, acceptsTactic } from "../bench/tactics";
import { positionForSide } from "../src/board";
import { sides } from "../src/types";

const initial = () =>
  restoreAnalysisPosition({
    schemaVersion: 1,
    rulesVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: false,
    },
    events: [],
  });
function setup(state: FourShogiState): AnalysisSetupInput {
  return {
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
  };
}
function run(position: AnalysisPosition, lanes: number, depth: number): StudyCandidate[] {
  const sessions = Array.from({ length: lanes }, (_, lane) =>
    createStudyRootSearch(position, {
      lane,
      lanes,
      maxDepth: depth,
      extensions: 0,
      width: 3,
      rootWidth: 6,
      dangerWork: 16,
    }),
  );
  try {
    for (let level = 1; level <= depth; level++) {
      for (const session of sessions) {
        let steps = 0;
        while (session.depth < level && !session.step())
          if (++steps > 2000000) throw new Error("test search runaway");
      }
      if (level === 1) {
        const selected = selectStudyRootIndices(
          sessions.flatMap((entry) => entry.snapshot().candidates),
          position.state.turn!,
          6,
        );
        sessions.forEach((session) => session.setRootIndices(selected));
      }
    }
    return sessions
      .flatMap((entry) => entry.snapshot().candidates)
      .sort((a, b) => compareStudyCandidates(a, b, position.state.turn!));
  } finally {
    sessions.forEach((entry) => entry.dispose());
  }
}
test("root splitting preserves the same root, four values, completed depth and actual PV", async () => {
  const position = await initial();
  const before = structuredClone(position.state);
  const serial = run(position, 1, 2);
  const parallel = run(position, 4, 2);
  expect(parallel).toEqual(serial);
  expect(parallel[0].completedDepth).toBe(2);
  expect(Object.keys(parallel[0].evaluation!.values)).toHaveLength(4);
  expect(position.state).toEqual(before);
  for (const candidate of parallel) {
    let state = position.state;
    for (const step of candidate.line) {
      expect(step.side).toBe(state.turn!);
      const result = applyAction(state, step.side, step.action);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(step.nextTurn).toBe(result.state.turn);
        state = result.state;
      }
    }
  }
});
test("study prefers the magic capture and retains the original side through skipped turns", async () => {
  const state = positionFixture({
    kings: { south: "A8", east: "C8" },
    pieces: [
      { side: "south", kind: "rook", at: "E3" },
      { side: "west", kind: "gold", at: "C3" },
      { side: "north", kind: "silver", at: "B4" },
    ],
  });
  const position = await createAnalysisSetupPosition(setup(state));
  const candidates = run(position, 2, 2);
  const best = candidates[0];
  expect(best.line[0].captured?.kind).toBe("gold");
  expect(best.study.magic).toBe(true);
  expect(best.line[0].nextTurn).toBe("east");
  expect(best.line[1].nextTurn).toBe("south");
});
test("sessions preserve work and tactical evidence across incremental stepping", async () => {
  const position = await initial();
  const session = createStudyRootSearch(position, { maxDepth: 2, extensions: 0, rootWidth: 5 });
  while (session.depth < 1) session.step();
  const selected = selectStudyRootIndices(session.snapshot().candidates, "south", 5);
  session.setRootIndices(selected);
  let steps = 0;
  while (!session.snapshot().candidates.some((entry) => entry.study.immediateRepliesComplete)) {
    session.step();
    if (++steps > 100000) throw new Error("inspection missing");
  }
  const paused = session.snapshot();
  const seen = paused.candidates
    .filter((entry) => entry.study.immediateRepliesComplete)
    .map((entry) => entry.rootIndex);
  expect(session.snapshot()).toEqual(paused);
  while (!session.step()) {}
  expect(session.snapshot().stats.work).toBeGreaterThan(paused.stats.work);
  for (const index of seen)
    expect(
      session.snapshot().candidates.find((entry) => entry.rootIndex === index)?.study
        .immediateRepliesComplete,
    ).toBe(true);
  expect(getLegalActions(position.state)).toContainEqual(session.snapshot().candidates[0].action);
});
test("study evaluation requires a trusted origin and exposes points, never probabilities", async () => {
  const position = await initial();
  expect(() => evaluateStudyPosition(structuredClone(position))).toThrow();
  const evaluation = evaluateStudyPosition(position);
  expect(evaluation.probabilities).toBeNull();
  expect(evaluation.values.south.heuristicScore).toBeFinite();
});

test("浅いマジック候補を自手番の復帰確認と区別する", async () => {
  const state = positionFixture({
    kings: { south: "A8", east: "C8" },
    pieces: [
      { side: "south", kind: "rook", at: "E3" },
      { side: "west", kind: "gold", at: "C3" },
      { side: "north", kind: "silver", at: "B4" },
    ],
  });
  const position = await createAnalysisSetupPosition(setup(state));
  const candidate = run(position, 1, 1).find((entry) => entry.study.magic);
  expect(candidate?.study).toMatchObject({
    rightSide: "east",
    magicEvidence: { status: "candidate", target: "east", returnedAtPly: null },
  });
});

test("飛車以外の駒損も実際の次自手番までの証拠に含める", async () => {
  const position = await createAnalysisSetupPosition(
    setup(
      positionFixture({
        pieces: [
          { side: "south", kind: "pawn", at: "E5" },
          { side: "west", kind: "rook", at: "E3" },
        ],
      }),
    ),
  );
  const session = createStudyRootSearch(position, { maxDepth: 2, extensions: 0, dangerWork: 256 });
  try {
    while (session.depth < 1) session.step();
    const waiting = session
      .snapshot()
      .candidates.find(
        (entry) =>
          entry.action.type === "movePiece" &&
          entry.action.from.x === 0 &&
          entry.action.from.y === 8 &&
          entry.action.to.x === 1 &&
          entry.action.to.y === 8,
      )!;
    expect(waiting).toBeDefined();
    session.setRootIndices([waiting.rootIndex]);
    while (session.depth < 2 && !session.step()) {}
    const candidate = session.snapshot().candidates[0];
    expect(candidate.study).toMatchObject({ material: { initialAssets: 100 } });
    const material = candidate.study.material;
    expect(material.lossWitness?.some((step) => step.captured?.kind === "pawn")).toBe(true);
  } finally {
    session.dispose();
  }
});

test("右は各陣営の元の右隣で固定し、脱落後に別の相手へ付け替えない", () => {
  const expected = { south: "east", west: "south", north: "west", east: "north" } as const;
  for (const side of sides) {
    const state = positionFixture({ turn: side });
    expect(studyRightSide(state, side)).toBe(expected[side]);
    const eliminated = {
      ...state,
      eliminations: [
        { side: expected[side] as typeof side, reason: "left" as const, rank: 4, group: 1 },
      ],
    };
    expect(studyRightSide(eliminated, side)).toBeNull();
  }
});

test("四方向とON/OFFでマジック候補の実手番復帰と駒得を読む", async () => {
  const base = positionFixture({
    kings: { south: "A8", east: "C8" },
    pieces: [
      { side: "south", kind: "rook", at: "E3" },
      { side: "west", kind: "gold", at: "C3" },
      { side: "north", kind: "silver", at: "B4" },
    ],
  });
  for (const restricted of [false, true])
    for (const [offset, side] of sides.entries()) {
      const board = base.board.map((row) =>
        row.map(() => null),
      ) as FourShogiState["board"][number][number][][];
      for (let y = 0; y < 9; y++)
        for (let x = 0; x < 9; x++) {
          const piece = base.board[y][x];
          const to = positionForSide({ x, y }, side);
          board[to.y][to.x] = piece
            ? { ...piece, side: sides[(sides.indexOf(piece.side) + offset) % 4] }
            : null;
        }
      const position = await createAnalysisSetupPosition(
        setup({
          ...base,
          status: "playing",
          result: null,
          board,
          turn: side,
          threePlayerAttackProhibited: restricted,
        }),
      );
      const candidate = run(position, 2, 2)[0];
      expect(candidate.line[0].captured?.kind).toBe("gold");
      expect(candidate.line[0].nextTurn).toBe(candidate.study.rightSide);
      expect(candidate.line[1].nextTurn).toBe(side);
      expect(candidate.study.magicEvidence).toMatchObject({
        status: "line_confirmed",
        returnedAtPly: 2,
      });
      expect(candidate.study.material.lineDelta).toBeGreaterThanOrEqual(500);
    }
});

test("右攻めの加点より自王の即脱落回避と確定単独勝ちを優先する", async () => {
  const cases = tacticalCases().filter(
    (entry) =>
      entry.state.mode === "singles" && entry.critical && ["safe", "win"].includes(entry.criterion),
  );
  expect(cases.length).toBeGreaterThan(0);
  for (const entry of cases) {
    const position = await createAnalysisSetupPosition(setup(entry.state));
    expect(acceptsTactic(entry, run(position, 1, 2)[0]?.action ?? null)).toBe(true);
  }
});
