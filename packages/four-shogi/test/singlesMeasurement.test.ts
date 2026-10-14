import { expect, test } from "bun:test";
import { eliminateSide, getLegalActions } from "../src/index";
import { sides, type FourShogiState } from "../src/types";
import { fixture } from "../bench/positionFixture";
import { initialPosition } from "../bench/measurement";
import {
  hashJson,
  matchStarts,
  playSingles,
  resultLabels,
  seatLineup,
  summarizeSingles,
  type SinglesSample,
  type MeasuredSelector,
} from "../bench/singlesMeasurement";

const firstLegal: MeasuredSelector = (state) => ({
  action: getLegalActions(state)[0] ?? null,
  stats: null,
});
function sample(seriesId: string, seat: (typeof sides)[number], soleFirst: boolean): SinglesSample {
  return {
    matchId: `${seriesId}-${seat}`,
    seriesId,
    startKind: "opening",
    seed: 10,
    seat,
    lineup: seatLineup(seat, "candidate", ["a", "b", "c"]),
    status: "finished",
    moves: 1,
    rank: soleFirst ? 1 : 4,
    soleFirst,
    tiedFirst: false,
    noSoleWinner: false,
    termination: "last_player",
    eliminations: [],
    finalStateHash: "fixture",
    trajectoryHash: "fixture",
    decisions: [],
  };
}

test("ON/OFFとseedを含む完全開始状態を再現し、固定初期配置の重複系列を拒否する", () => {
  for (const restricted of [false, true]) {
    const a = matchStarts("mixed", restricted, 2, 1000);
    expect(a).toEqual(matchStarts("mixed", restricted, 2, 1000));
    expect(a[0].state).toEqual(initialPosition("singles", restricted));
    expect(a[1].kind).toBe("opening");
    expect(a[1].state.moveNumber).toBe(12);
    expect(a[1].seriesId).not.toBe(a[0].seriesId);
  }
  expect(matchStarts("initial", true, 1, 10)[0].seriesId).not.toBe(
    matchStarts("initial", false, 1, 10)[0].seriesId,
  );
  expect(() => matchStarts("initial", true, 2, 10)).toThrow();
});

test("候補席を四席に均等化し、異種相手の相対配置を維持する", () => {
  expect(sides.map((seat) => seatLineup(seat, "C", ["A", "B", "D"]))).toEqual([
    { south: "C", west: "A", north: "B", east: "D" },
    { west: "C", north: "A", east: "B", south: "D" },
    { north: "C", east: "A", south: "B", west: "D" },
    { east: "C", south: "A", west: "B", north: "D" },
  ]);
  expect(() => seatLineup("south", "C", ["A"])).toThrow();
});

test("同率1位と下位者と未終局を単独勝者なしの確定終局から区別する", () => {
  const base = fixture();
  const draw: FourShogiState = {
    ...base,
    status: "finished",
    turn: null,
    result: {
      mode: "singles",
      reason: "repetition",
      standings: [
        { side: "south", rank: 1 },
        { side: "west", rank: 1 },
        { side: "north", rank: 3 },
        { side: "east", rank: 4 },
      ],
    },
  };
  expect(resultLabels(draw, "south")).toEqual({
    rank: 1,
    soleFirst: false,
    tiedFirst: true,
    noSoleWinner: true,
  });
  expect(resultLabels(draw, "east")).toEqual({
    rank: 4,
    soleFirst: false,
    tiedFirst: false,
    noSoleWinner: true,
  });
  expect(resultLabels(base, "south")).toEqual({
    rank: null,
    soleFirst: false,
    tiedFirst: false,
    noSoleWinner: false,
  });
  const won: FourShogiState = {
    ...draw,
    result: {
      mode: "singles",
      reason: "last_player",
      standings: sides.map((side, index) => ({ side, rank: index + 1 })),
    },
  };
  expect(resultLabels(won, "south").soleFirst).toBe(true);
});

test("同じ系列の四席は一つの標本群、重複対局は集計を拒否し、未終局を分母から落とさない", () => {
  const samples = [
    ...sides.map((seat) => sample("a", seat, true)),
    ...sides.map((seat) => sample("b", seat, false)),
  ];
  const result = summarizeSingles(samples);
  expect(result.openingSeries).toBe(2);
  expect(result.soleFirstRate).toBe(0.5);
  expect(result.soleFirstInterval95).toEqual([0, 1]);
  expect(summarizeSingles(samples.slice(0, 4)).soleFirstInterval95).toBeNull();
  expect(() => summarizeSingles([...samples, samples[0]])).toThrow("重複対局");
  const unfinished: SinglesSample = {
    ...sample("c", "south", false),
    status: "unfinished",
    rank: null,
    termination: "max_plies",
  };
  const withUnfinished = summarizeSingles([samples[0], unfinished]);
  expect(withUnfinished.soleFirstRate).toBe(0.5);
  expect(withUnfinished.unfinished).toBe(1);
  expect(withUnfinished.noSoleWinner).toBe(0);
  expect(withUnfinished.averageFinishedRank).toBe(1);
});

test("両設定の実手番と合法遷移を使い、同じseedの対局と時間以外の集計を再現する", () => {
  for (const restricted of [false, true]) {
    const start = matchStarts("initial", restricted, 1, 10)[0];
    const original = hashJson(start.state);
    const lineup = seatLineup("east", "candidate", ["baseline", "baseline", "baseline"]);
    const selectors = new Map([
      ["candidate", firstLegal],
      ["baseline", firstLegal],
    ]);
    const a = playSingles(start, "east", lineup, selectors, 4);
    const b = playSingles(start, "east", lineup, selectors, 4);
    expect(a.finalStateHash).toBe(b.finalStateHash);
    expect(a.trajectoryHash).toBe(b.trajectoryHash);
    expect(summarizeSingles([a])).toEqual(summarizeSingles([b]));
    expect(a.status).toBe("unfinished");
    expect(a.noSoleWinner).toBe(false);
    expect(a.decisions.map((entry) => entry.side)).toEqual([...sides]);
    expect(hashJson(start.state)).toBe(original);
  }
});

test("不正着手を測定失敗にし、実際の終局理由と脱落を保持する", () => {
  const state = initialPosition("singles", false);
  const start = { kind: "initial" as const, seed: 1, seriesId: hashJson(state), state };
  const lineup = seatLineup("south", "invalid", ["invalid", "invalid", "invalid"]);
  const illegal: MeasuredSelector = () => ({
    action: { type: "dropPiece", pieceKind: "rook", to: { x: 4, y: 4 } },
    stats: null,
  });
  expect(() => playSingles(start, "south", lineup, new Map([["invalid", illegal]]), 1)).toThrow(
    "不正着手",
  );
  const mutating: MeasuredSelector = (input) => {
    const action = getLegalActions(input)[0];
    (input as unknown as { moveNumber: number }).moveNumber++;
    return { action, stats: null };
  };
  const mutableState = initialPosition("singles", false);
  expect(() =>
    playSingles(
      { ...start, state: mutableState },
      "south",
      lineup,
      new Map([["invalid", mutating]]),
      1,
    ),
  ).toThrow("入力状態を変更");
  let terminal = state;
  for (const side of ["west", "north", "east"] as const) {
    const result = eliminateSide(terminal, side, "left");
    if (!result.ok) throw new Error(result.reason);
    terminal = result.state;
  }
  const terminalStart = { ...start, state: terminal, seriesId: hashJson(terminal) };
  const result = playSingles(terminalStart, "south", lineup, new Map(), 1);
  expect(result.status).toBe("finished");
  expect(result.termination).toBe("last_player");
  expect(result.soleFirst).toBe(true);
  expect(result.eliminations.map((entry) => entry.reason)).toEqual(["left", "left", "left"]);
});
