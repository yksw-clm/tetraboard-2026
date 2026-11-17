import type { MatchmakingGame } from "@tetraboard/protocol";
import type { FourReversiRatingSource, QueueRating } from "./fourReversiSelection";
import type { FourShogiRatingSource } from "./fourShogiSelection";
export type EloRatingSource =
  | { kind: "human" }
  | { kind: "cpu"; profileId: string; referenceRating: number; usedFallback?: true };
type ShogiRatingSource = EloRatingSource;
export type RatedPolicy = {
  initialRating: number;
  initialSigma?: number;
  wideningTimesMs: number[];
  select<T extends QueueRating>(
    eligible: T[],
    elapsed: number,
  ): { selected: T[]; rating: QueueRatingSource } | undefined;
  validParticipants(rating: QueueRatingSource, humans: number): boolean;
};
import { fourReversiWidenAfterMs, fourReversiCalibrationVersion } from "./fourReversiSelection";
import { fourShogiCalibrationVersion } from "./fourShogiSelection";
import { shogiCpuProfile, selectShogiCpu } from "./shogiCpuProfiles";
import type { createFourReversiSelection } from "./fourReversiSelection";
import type { createFourShogiSelection } from "./fourShogiSelection";
import type { createReversiCpuProfiles } from "./reversiCpuProfiles";
export type ReversiQueueRating = { kind: "reversi"; source: EloRatingSource };
export type QueueRatingSource =
  | ShogiRatingSource
  | FourReversiRatingSource
  | FourShogiRatingSource
  | ReversiQueueRating;
export function ratingOpponentKind(rating: QueueRatingSource) {
  if (rating.kind === "reversi") return rating.source.kind;
  return rating.kind === "four-reversi" || rating.kind === "four-shogi"
    ? rating.cpu
      ? "cpu"
      : "human"
    : rating.kind;
}

export type RatedPolicyConfiguration = ReturnType<typeof createFourReversiSelection> &
  ReturnType<typeof createFourShogiSelection> &
  ReturnType<typeof createReversiCpuProfiles> & {
    queues: Record<MatchmakingGame, { seats: number; fillAfterMs: number }>;
    shogiInitialRating: number;
    initialFourReversiRating: { mu: number; sigma: number };
  };
export function createRatedMatchmakingPolicies(configuration: RatedPolicyConfiguration) {
  return {
    shogi: shogiPolicy(configuration),
    reversi: reversiPolicy(configuration),
    "four-reversi": fourReversiPolicy(configuration),
    "four-shogi": fourShogiPolicy(configuration),
  };
}
const widening = [
  { afterMs: 5000, maxDifference: 200 },
  { afterMs: 10_000, maxDifference: 300 },
];

function selectDuel<T extends QueueRating>(
  eligible: T[],
  elapsed: number,
  shogiInitialRating: number,
) {
  const [oldest, ...candidates] = eligible;
  if (!oldest) return;
  const allowedDifference =
    widening.findLast(({ afterMs }) => elapsed >= afterMs)?.maxDifference ?? 100;
  const anchor = oldest.rating ?? shogiInitialRating;
  const opponent = candidates.find(
    (candidate) => Math.abs((candidate.rating ?? shogiInitialRating) - anchor) <= allowedDifference,
  );
  return { oldest, opponent, anchor };
}

function shogiPolicy(configuration: RatedPolicyConfiguration) {
  function selectShogi<T extends QueueRating>(eligible: T[], elapsed: number) {
    const duel = selectDuel(eligible, elapsed, configuration.shogiInitialRating);
    if (!duel) return;
    const { oldest, opponent, anchor } = duel;
    if (opponent) return { selected: [oldest, opponent], rating: { kind: "human" as const } };
    if (elapsed >= configuration.queues.shogi.fillAfterMs)
      return { selected: [oldest], rating: selectShogiCpu(anchor) };
  }

  return {
    initialRating: configuration.shogiInitialRating,
    initialSigma: undefined,
    wideningTimesMs: widening.map(({ afterMs }) => afterMs),
    validParticipants(rating: QueueRatingSource, humans: number) {
      if (rating.kind !== "human" && rating.kind !== "cpu") return false;
      const seats = configuration.queues.shogi.seats;
      return rating.kind === "human"
        ? humans === seats
        : humans === seats - 1 && shogiCpuProfile(rating.profileId) !== undefined;
    },
    select: selectShogi,
  };
}
function reversiPolicy(configuration: RatedPolicyConfiguration) {
  return {
    initialRating: configuration.shogiInitialRating,
    initialSigma: undefined,
    wideningTimesMs: widening.map(({ afterMs }) => afterMs),
    validParticipants(rating: QueueRatingSource, humans: number) {
      if (rating.kind !== "reversi") return false;
      const { source } = rating;
      const { seats } = configuration.queues.reversi;
      return source.kind === "human"
        ? humans === seats
        : humans === seats - 1 && !!configuration.reversiCpuProfile(source);
    },
    select<T extends QueueRating>(eligible: T[], elapsed: number) {
      const duel = selectDuel(eligible, elapsed, configuration.shogiInitialRating);
      if (!duel) return;
      const { oldest, opponent, anchor } = duel;
      if (opponent)
        return {
          selected: [oldest, opponent],
          rating: { kind: "reversi", source: { kind: "human" } } satisfies ReversiQueueRating,
        };
      if (elapsed >= configuration.queues.reversi.fillAfterMs)
        return {
          selected: [oldest],
          rating: {
            kind: "reversi",
            source: configuration.selectReversiCpu(anchor),
          } satisfies ReversiQueueRating,
        };
    },
  };
}
function fourReversiPolicy(configuration: RatedPolicyConfiguration) {
  return {
    initialRating: configuration.initialFourReversiRating.mu,
    initialSigma: configuration.initialFourReversiRating.sigma,
    wideningTimesMs: [fourReversiWidenAfterMs],
    validParticipants(rating: QueueRatingSource, humans: number) {
      if (
        rating.kind !== "four-reversi" ||
        rating.calibrationVersion !== fourReversiCalibrationVersion
      )
        return false;
      const { seats } = configuration.queues["four-reversi"];
      return humans === seats
        ? !rating.cpu
        : !!rating.cpu && !!configuration.calibratedFourReversiProfile(rating.cpu);
    },
    select: configuration.selectFourReversi,
  };
}
function fourShogiPolicy(configuration: RatedPolicyConfiguration) {
  return {
    ...fourReversiPolicy(configuration),
    validParticipants(rating: QueueRatingSource, humans: number) {
      if (rating.kind !== "four-shogi" || rating.calibrationVersion !== fourShogiCalibrationVersion)
        return false;
      return humans === configuration.queues["four-shogi"].seats
        ? !rating.cpu
        : !!rating.cpu && !!configuration.calibratedFourShogiProfile(rating.cpu);
    },
    select: configuration.selectFourShogi,
  };
}
