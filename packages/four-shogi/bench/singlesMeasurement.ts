import { applyAction } from "../src/index";
import { sides, type FourShogiState, type FourShogiAction, type Side } from "../src/types";
import { initialPosition, openingPosition, seededRandom } from "./measurement";

export function hashJson(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

export type Start = {
  kind: "initial" | "opening";
  seed: number;
  seriesId: string;
  state: FourShogiState;
};
export function matchStarts(
  kind: "initial" | "opening" | "mixed",
  restricted: boolean,
  count: number,
  seed: number,
): Start[] {
  if (!Number.isSafeInteger(count) || count < 1 || (kind === "initial" && count !== 1))
    throw new Error("開始系列数は正の整数、initialは1系列を指定してください");
  const seen = new Set<string>();
  return Array.from({ length: count }, (_, index) => {
    const initial = kind === "initial" || (kind === "mixed" && index === 0);
    const currentSeed = seed + index;
    const state = initial
      ? initialPosition("singles", restricted)
      : openingPosition("singles", restricted, currentSeed);
    const seriesId = hashJson(state);
    if (seen.has(seriesId)) throw new Error(`重複した開始局面: seed=${currentSeed}`);
    seen.add(seriesId);
    return { kind: initial ? "initial" : "opening", seed: currentSeed, seriesId, state };
  });
}

export type Decision = {
  action: FourShogiAction | null;
  stats: { work: number; completedDepth: number; cutoff: boolean } | null;
};
export type MeasuredSelector = (state: FourShogiState) => Decision;
export type SinglesSample = {
  matchId: string;
  seriesId: string;
  startKind: Start["kind"];
  seed: number;
  seat: Side;
  lineup: Record<Side, string>;
  status: "finished" | "unfinished";
  moves: number;
  rank: number | null;
  soleFirst: boolean;
  tiedFirst: boolean;
  noSoleWinner: boolean;
  termination: string;
  eliminations: FourShogiState["eliminations"];
  finalStateHash: string;
  trajectoryHash: string;
  decisions: {
    side: Side;
    playerId: string;
    elapsedMs: number;
    rssBytes: number;
    stats: Decision["stats"];
  }[];
};

export function seatLineup(
  seat: Side,
  candidateId: string,
  opponents: readonly string[],
): Record<Side, string> {
  if (opponents.length !== 3) throw new Error("相手は3体を指定してください");
  const entries: [Side, string][] = [[seat, candidateId]];
  const index = sides.indexOf(seat);
  for (let offset = 1; offset <= 3; offset++)
    entries.push([sides[(index + offset) % 4], opponents[offset - 1]]);
  return Object.fromEntries(entries) as Record<Side, string>;
}

export function resultLabels(state: FourShogiState, seat: Side) {
  if (state.mode !== "singles") throw new Error("シングルス専用です");
  if (state.status !== "finished")
    return { rank: null, soleFirst: false, tiedFirst: false, noSoleWinner: false };
  if (state.result.mode !== "singles") throw new Error("結果のモードが不正です");
  const first = state.result.standings.filter((entry) => entry.rank === 1);
  const rank = state.result.standings.find((entry) => entry.side === seat)?.rank;
  if (rank === undefined) throw new Error("確定順位がありません");
  return {
    rank,
    soleFirst: rank === 1 && first.length === 1,
    tiedFirst: rank === 1 && first.length > 1,
    noSoleWinner: first.length !== 1,
  };
}

export function playSingles(
  start: Start,
  seat: Side,
  lineup: Record<Side, string>,
  selectors: ReadonlyMap<string, MeasuredSelector>,
  maxPlies: number,
): SinglesSample {
  if (!Number.isSafeInteger(maxPlies) || maxPlies < 1) throw new Error("手数上限は正の整数です");
  let state = start.state;
  if (state.mode !== "singles" || hashJson(state) !== start.seriesId)
    throw new Error("開始状態のモードまたはhashが不一致です");
  const decisions: SinglesSample["decisions"] = [];
  const trajectory = new Bun.CryptoHasher("sha256").update(start.seriesId);
  while (state.status === "playing" && decisions.length < maxPlies) {
    const side = state.turn;
    const playerId = lineup[side];
    const selector = selectors.get(playerId);
    if (!selector) throw new Error(`未登録のAI: ${playerId}`);
    const inputHash = hashJson(state);
    const before = performance.now();
    const decision = selector(state);
    const elapsedMs = performance.now() - before;
    if (hashJson(state) !== inputHash) throw new Error(`入力状態を変更したAI: ${playerId}`);
    if (!decision.action) throw new Error(`合法手を返さないAI: ${playerId}`);
    const result = applyAction(state, side, decision.action);
    if (!result.ok) throw new Error(`AIの不正着手: ${playerId}/${result.reason}`);
    trajectory.update(JSON.stringify({ side, action: decision.action }));
    state = result.state;
    decisions.push({
      side,
      playerId,
      elapsedMs,
      rssBytes: process.memoryUsage().rss,
      stats: decision.stats,
    });
  }
  return {
    matchId: hashJson({ seriesId: start.seriesId, seat, lineup }),
    seriesId: start.seriesId,
    startKind: start.kind,
    seed: start.seed,
    seat,
    lineup,
    status: state.status === "finished" ? "finished" : "unfinished",
    moves: decisions.length,
    ...resultLabels(state, seat),
    termination: state.status === "finished" ? state.result!.reason : "max_plies",
    eliminations: state.eliminations,
    finalStateHash: hashJson(state),
    trajectoryHash: trajectory.digest("hex"),
    decisions,
  };
}

export function summarizeSingles(samples: readonly SinglesSample[], calculateInterval = true) {
  if (samples.length === 0) throw new Error("対戦結果がありません");
  const ids = new Set<string>();
  const groups = new Map<string, SinglesSample[]>();
  for (const sample of samples) {
    if (ids.has(sample.matchId)) throw new Error(`重複対局: ${sample.matchId}`);
    ids.add(sample.matchId);
    groups.set(sample.seriesId, [...(groups.get(sample.seriesId) ?? []), sample]);
  }
  const values = [...groups.values()];
  const random = seededRandom(0x185);
  const intervals =
    !calculateInterval || values.length < 2
      ? null
      : Array.from({ length: 1000 }, () => {
          const chosen = Array.from(
            { length: values.length },
            () => values[Math.floor(random() * values.length)],
          ).flat();
          return chosen.filter((entry) => entry.soleFirst).length / chosen.length;
        }).sort((a, b) => a - b);
  const ranked = samples.filter((entry) => entry.rank !== null);
  const counts = (values: readonly string[]) =>
    Object.fromEntries(
      [...new Set(values)]
        .sort()
        .map((key) => [key, values.filter((value) => value === key).length]),
    );
  return {
    games: samples.length,
    startSeries: groups.size,
    openingSeries: values.filter((group) => group[0].startKind === "opening").length,
    initialSeries: values.filter((group) => group[0].startKind === "initial").length,
    startKindCounts: counts(samples.map((entry) => entry.startKind)),
    soleFirst: samples.filter((entry) => entry.soleFirst).length,
    soleFirstRate: samples.filter((entry) => entry.soleFirst).length / samples.length,
    tiedFirst: samples.filter((entry) => entry.tiedFirst).length,
    noSoleWinner: samples.filter((entry) => entry.noSoleWinner).length,
    unfinished: samples.filter((entry) => entry.status === "unfinished").length,
    averageFinishedRank: ranked.length
      ? ranked.reduce((sum, entry) => sum + entry.rank!, 0) / ranked.length
      : null,
    soleFirstInterval95: intervals ? [intervals[24], intervals[974]] : null,
    intervalStatus: !calculateInterval
      ? "pending"
      : values.length < 2
        ? "insufficient_series"
        : "calculated",
    intervalMethod: "opening-series-cluster-bootstrap/1000; fewer-than-2-series=null",
    seatCounts: Object.fromEntries(
      sides.map((side) => [side, samples.filter((entry) => entry.seat === side).length]),
    ),
    terminationCounts: counts(samples.map((entry) => entry.termination)),
    eliminationCounts: counts(
      samples.flatMap((entry) => entry.eliminations.map((elimination) => elimination.reason)),
    ),
    candidateEliminationCounts: counts(
      samples.flatMap((entry) =>
        entry.eliminations
          .filter((elimination) => elimination.side === entry.seat)
          .map((elimination) => elimination.reason),
      ),
    ),
  };
}
