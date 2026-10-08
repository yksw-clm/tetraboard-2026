import { createInitialState, applyAction, getLegalActions } from "../src/index";
import {
  sides,
  teamForSide,
  type FourShogiState,
  type Side,
  type GameMode,
  type FourShogiAction,
} from "../src/types";

export type Selector = (state: FourShogiState) => FourShogiAction | null;
export type MatchSample = {
  seed: number;
  seat: Side;
  status: "finished" | "unfinished";
  moves: number;
  rank: number | null;
  win: boolean;
  draw: boolean;
  score: number;
};

export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function initialPosition(mode: GameMode, restricted: boolean): FourShogiState {
  return createInitialState({
    mode,
    threePlayerAttackProhibited: restricted,
    players: { south: "south", west: "west", north: "north", east: "east" },
  });
}

export function openingPosition(mode: GameMode, restricted: boolean, seed: number): FourShogiState {
  let state = initialPosition(mode, restricted);
  const random = seededRandom(seed);
  for (let ply = 0; ply < 12 && state.status === "playing"; ply++) {
    const actions = getLegalActions(state);
    const action = actions[Math.floor(random() * actions.length)];
    if (!action) throw new Error("開始系列に合法手がありません");
    const result = applyAction(state, state.turn, action);
    if (!result.ok) throw new Error(`開始系列が不正です: ${result.reason}`);
    state = result.state;
  }
  if (state.status !== "playing" || state.eliminations.length !== 0) {
    throw new Error(`開始系列seed=${seed}が対戦前に終局・脱落しました`);
  }
  return state;
}

export function playMatch(
  state: FourShogiState,
  candidate: Selector,
  baseline: Selector,
  seat: Side,
  seed: number,
  maxPlies: number,
): MatchSample {
  let moves = 0;
  while (state.status === "playing" && moves < maxPlies) {
    const isCandidate =
      state.mode === "singles"
        ? state.turn === seat
        : teamForSide(state.turn) === teamForSide(seat);
    const action = (isCandidate ? candidate : baseline)(state);
    if (!action) throw new Error("対戦中にAIが合法手を返しませんでした");
    const result = applyAction(state, state.turn, action);
    if (!result.ok) throw new Error(`AIの不正着手: ${result.reason}`);
    state = result.state;
    moves++;
  }
  if (state.status !== "finished") {
    return {
      seed,
      seat,
      moves,
      status: "unfinished",
      rank: null,
      win: false,
      draw: false,
      score: 0,
    };
  }
  if (state.result.mode === "doubles") {
    const draw = state.result.winner === null;
    const win = state.result.winner === teamForSide(seat);
    return {
      seed,
      seat,
      moves,
      status: "finished",
      rank: null,
      win,
      draw,
      score: win ? 1 : draw ? 0.5 : 0,
    };
  }
  const rank = state.result.standings.find((entry) => entry.side === seat)!.rank;
  const draw = state.result.reason !== "last_player";
  const win = !draw && rank === 1;
  return { seed, seat, moves, status: "finished", rank, win, draw, score: Number(win) };
}

export function summarizeMatches(samples: readonly MatchSample[]) {
  if (samples.length === 0) throw new Error("対戦結果がありません");
  const groups = new Map<number, MatchSample[]>();
  for (const sample of samples)
    groups.set(sample.seed, [...(groups.get(sample.seed) ?? []), sample]);
  const values = [...groups.values()];
  const random = seededRandom(0x102908);
  const bootstraps: number[] = [];
  for (let iteration = 0; iteration < 1000; iteration++) {
    const chosen = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)],
    ).flat();
    bootstraps.push(chosen.reduce((sum, sample) => sum + sample.score, 0) / chosen.length);
  }
  bootstraps.sort((a, b) => a - b);
  const ranked = samples.filter((sample) => sample.rank !== null);
  return {
    games: samples.length,
    openingSeries: groups.size,
    wins: samples.filter((sample) => sample.win).length,
    winRate: samples.filter((sample) => sample.win).length / samples.length,
    scoreRate: samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length,
    drawRate: samples.filter((sample) => sample.draw).length / samples.length,
    unfinishedRate:
      samples.filter((sample) => sample.status === "unfinished").length / samples.length,
    averageRank:
      ranked.length === 0
        ? null
        : ranked.reduce((sum, sample) => sum + sample.rank!, 0) / ranked.length,
    scoreInterval95: [bootstraps[24], bootstraps[974]],
    seatCounts: Object.fromEntries(
      sides.map((side) => [side, samples.filter((sample) => sample.seat === side).length]),
    ),
  };
}

export function summarizeTimes(times: readonly number[]) {
  if (times.length === 0) throw new Error("性能測定結果がありません");
  const sorted = [...times].sort((a, b) => a - b);
  return {
    samples: times.length,
    meanMs: times.reduce((sum, time) => sum + time, 0) / times.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1)!,
  };
}
