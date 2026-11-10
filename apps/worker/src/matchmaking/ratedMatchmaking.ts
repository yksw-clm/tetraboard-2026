import {
  fourReversiRatingSummarySchema,
  matchmakingQueues,
  shogiRatingSummarySchema,
  type MatchmakingGame,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { aiServiceConfigured, shogiAiEnabled } from "../rooms/aiService";
import {
  readShogiRatingResult,
  readShogiRatingSummary,
  shogiInitialRating,
  shogiRatingStore,
  type ShogiRatingSource,
} from "../rooms/shogiRating";
import { selectShogiCpu, shogiCpuNodes } from "./shogiCpuProfiles";

import { initialFourReversiRating } from "../../../../packages/ai/fourReversiRating";
import {
  fourReversiRatingStore,
  readFourReversiRatingResult,
  readFourReversiRatingSummary,
} from "../rooms/fourReversiRating";
import {
  calibratedFourReversiProfile,
  fourReversiWidenAfterMs,
  fourReversiCalibrationVersion,
  hasCalibratedFourReversiProfiles,
  selectFourReversi,
  type FourReversiRatingSource,
  type QueueRating,
} from "./fourReversiSelection";

export type QueueRatingSource = ShogiRatingSource | FourReversiRatingSource;
export function ratingOpponentKind(rating: QueueRatingSource) {
  return rating.kind === "four-reversi" ? (rating.cpu ? "cpu" : "human") : rating.kind;
}

const widening = [
  { afterMs: 5000, maxDifference: 200 },
  { afterMs: 10_000, maxDifference: 300 },
];

const shogi = {
  enabled: (env: Env) => env.SHOGI_MATCHMAKING_ENABLED === "true" && shogiAiEnabled(env),
  store: shogiRatingStore,
  readResult: readShogiRatingResult,
  async readSummary(db: D1Database, accountId: string) {
    return shogiRatingSummarySchema.parse(await readShogiRatingSummary(db, accountId));
  },
  initialRating: shogiInitialRating,
  initialSigma: undefined,
  wideningTimesMs: widening.map(({ afterMs }) => afterMs),
  validParticipants(rating: QueueRatingSource, humans: number) {
    if (rating.kind === "four-reversi") return false;
    const seats = matchmakingQueues.shogi.seats;
    return rating.kind === "human"
      ? humans === seats
      : humans === seats - 1 && shogiCpuNodes(rating.profileId) !== undefined;
  },
  select<T extends QueueRating>(eligible: T[], elapsed: number) {
    const [oldest, ...candidates] = eligible;
    if (!oldest) return;
    const allowedDifference =
      widening.findLast(({ afterMs }) => elapsed >= afterMs)?.maxDifference ?? 100;
    const anchor = oldest.rating ?? shogiInitialRating;
    const opponent = candidates.find(
      (candidate) =>
        Math.abs((candidate.rating ?? shogiInitialRating) - anchor) <= allowedDifference,
    );
    if (opponent) return { selected: [oldest, opponent], rating: { kind: "human" as const } };
    if (elapsed >= matchmakingQueues.shogi.fillAfterMs)
      return { selected: [oldest], rating: selectShogiCpu(anchor) };
  },
};

const fourReversi = {
  enabled: (env: Env) =>
    env.MATCHMAKING_ENABLED === "true" &&
    aiServiceConfigured(env) &&
    hasCalibratedFourReversiProfiles(),
  store: fourReversiRatingStore,
  readResult: readFourReversiRatingResult,
  async readSummary(db: D1Database, accountId: string) {
    return fourReversiRatingSummarySchema.parse(await readFourReversiRatingSummary(db, accountId));
  },
  initialRating: initialFourReversiRating.mu,
  initialSigma: initialFourReversiRating.sigma,
  wideningTimesMs: [fourReversiWidenAfterMs],
  validParticipants(rating: QueueRatingSource, humans: number) {
    if (
      rating.kind !== "four-reversi" ||
      rating.calibrationVersion !== fourReversiCalibrationVersion
    )
      return false;
    const { seats } = matchmakingQueues["four-reversi"];
    return humans === seats
      ? !rating.cpu
      : !!rating.cpu && !!calibratedFourReversiProfile(rating.cpu);
  },
  select: selectFourReversi,
};

const policies = { shogi, "four-reversi": fourReversi } satisfies Record<
  RatedMatchmakingGame,
  unknown
>;

export function ratedMatchmakingPolicy(game: MatchmakingGame) {
  return policies[game];
}
