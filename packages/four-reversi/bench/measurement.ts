import {
  applyAction,
  colors,
  createInitialState,
  eliminateColor,
  getLegalMoves,
  type Color,
  type FourReversiState,
  type GameMode,
  type Position,
} from "../src/index";

export type Selector = (state: FourReversiState) => Position | null;
export type MatchSample = {
  seed: number;
  seat: Color;
  status: "finished" | "unfinished";
  moves: number;
  rank: number | null;
  win: boolean;
  sharedFirst: boolean;
  draw: boolean;
  score: number;
};
export const team = (color: Color) =>
  color === "black" || color === "red" ? "black-red" : "white-blue";

export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function positionAt(
  mode: GameMode,
  seed: number,
  plies: number,
  activeCount = 4,
): FourReversiState {
  let state = createInitialState(mode);
  const random = seededRandom(seed);
  for (let ply = 0; ply < plies && state.status === "playing"; ply++) {
    if (ply === 24 && mode === "singles") {
      for (const color of colors.slice(activeCount)) {
        const result = eliminateColor(state, color);
        if (!result.ok) throw new Error("脱落fixtureを作成できません");
        state = result.state;
      }
    }
    if (state.status !== "playing") break;
    const moves = getLegalMoves(state);
    const result = applyAction(state, {
      type: "placeStone",
      position: moves[Math.floor(random() * moves.length)],
    });
    if (!result.ok) throw new Error(`開始系列の不正手: ${result.reason}`);
    state = result.state;
  }
  return state;
}

export function openingPosition(mode: GameMode, seed: number): FourReversiState {
  const state = positionAt(mode, seed, 12);
  if (state.status !== "playing" || state.eliminatedColors.length !== 0)
    throw new Error("開始系列が対戦前に終局・脱落しました");
  return state;
}

export function playMatch(
  input: FourReversiState,
  candidate: Selector,
  baseline: Selector,
  seat: Color,
  seed: number,
  maxPlies = 56,
): MatchSample {
  let state = input;
  let moves = 0;
  while (state.status === "playing" && moves < maxPlies) {
    const own = state.mode === "singles" ? state.turn === seat : team(state.turn) === team(seat);
    const position = (own ? candidate : baseline)(state);
    if (!position) throw new Error("AIが合法手を返しませんでした");
    const result = applyAction(state, { type: "placeStone", position });
    if (!result.ok) throw new Error(`AIの不正着手: ${result.reason}`);
    state = result.state;
    moves++;
  }
  const sample: MatchSample = {
    seed,
    seat,
    status: state.status === "finished" ? "finished" : "unfinished",
    moves,
    rank: null,
    win: false,
    sharedFirst: false,
    draw: false,
    score: 0,
  };
  if (state.status !== "finished") return sample;
  if (state.result.mode === "singles") {
    sample.rank = state.result.standings.find((entry) => entry.color === seat)!.rank;
    sample.sharedFirst =
      sample.rank === 1 && state.result.standings.filter((entry) => entry.rank === 1).length > 1;
    sample.win = sample.rank === 1 && !sample.sharedFirst;
  } else {
    sample.draw = state.result.winner === null;
    sample.win = state.result.winner === team(seat);
  }
  sample.score = sample.win ? 1 : sample.draw ? 0.5 : 0;
  return sample;
}

export function summarizeMatches(samples: readonly MatchSample[]) {
  if (!samples.length) throw new Error("対戦結果がありません");
  const keys = new Set(samples.map((sample) => `${sample.seed}:${sample.seat}`));
  if (keys.size !== samples.length) throw new Error("対戦結果のseed・席が重複しています");
  const groups = new Map<number, MatchSample[]>();
  for (const sample of samples)
    groups.set(sample.seed, [...(groups.get(sample.seed) ?? []), sample]);
  const series = [...groups.values()];
  const random = seededRandom(0x102611);
  const intervals = Array.from({ length: 1000 }, () => {
    const chosen = Array.from(
      { length: series.length },
      () => series[Math.floor(random() * series.length)],
    ).flat();
    return chosen.reduce((sum, sample) => sum + sample.score, 0) / chosen.length;
  }).sort((a, b) => a - b);
  const ranked = samples.filter((sample) => sample.rank !== null);
  return {
    games: samples.length,
    openingSeries: groups.size,
    wins: samples.filter((sample) => sample.win).length,
    winRate: samples.filter((sample) => sample.win).length / samples.length,
    scoreRate: samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length,
    sharedFirstRate: samples.filter((sample) => sample.sharedFirst).length / samples.length,
    drawRate: samples.filter((sample) => sample.draw).length / samples.length,
    unfinishedRate:
      samples.filter((sample) => sample.status === "unfinished").length / samples.length,
    averageRank: ranked.length
      ? ranked.reduce((sum, sample) => sum + sample.rank!, 0) / ranked.length
      : null,
    scoreInterval95: [intervals[24], intervals[974]],
    seatCounts: Object.fromEntries(
      colors.map((color) => [color, samples.filter((sample) => sample.seat === color).length]),
    ),
  };
}

export function summarizeTimes(times: readonly number[]) {
  if (!times.length || times.some((time) => !Number.isFinite(time) || time < 0))
    throw new Error("性能測定値が不正です");
  const sorted = [...times].sort((a, b) => a - b);
  return {
    samples: times.length,
    meanMs: times.reduce((sum, time) => sum + time, 0) / times.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1)!,
  };
}
