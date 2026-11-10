import {
  fourReversiRatingSummarySchema,
  matchmakingQueues,
  shogiRatingSummarySchema,
  reversiRatingSummarySchema,
  type MatchmakingGame,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { aiServiceConfigured, reversiAiEnabled, shogiAiEnabled } from "../rooms/aiService";
import {
  readShogiRatingResult,
  readShogiRatingSummary,
  shogiInitialRating,
  shogiRatingStore,
  type ShogiRatingSource,
} from "../rooms/shogiRating";
import { selectShogiCpu, shogiCpuNodes } from "./shogiCpuProfiles";
import { reversiCpuProfile, selectReversiCpu } from "./reversiCpuProfiles";
import {
  readReversiRatingResult,
  readReversiRatingSummary,
  reversiRatingStore,
} from "../rooms/reversiRating";
import type { EloRatingSource } from "../rooms/eloRating";

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

type ReversiQueueRating = { kind: "reversi"; source: EloRatingSource };
export type QueueRatingSource = ShogiRatingSource | FourReversiRatingSource | ReversiQueueRating;
export function ratingOpponentKind(rating: QueueRatingSource) {
  if (rating.kind === "reversi") return rating.source.kind;
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
    if (rating.kind !== "human" && rating.kind !== "cpu") return false;
    const seats = matchmakingQueues.shogi.seats;
    return rating.kind === "human"
      ? humans === seats
      : humans === seats - 1 && shogiCpuNodes(rating.profileId) !== undefined;
  },
  select: selectShogi,
};

function selectDuel<T extends QueueRating>(eligible: T[], elapsed: number) {
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

function selectShogi<T extends QueueRating>(eligible: T[], elapsed: number) {
  const duel = selectDuel(eligible, elapsed);
  if (!duel) return;
  const { oldest, opponent, anchor } = duel;
  if (opponent) return { selected: [oldest, opponent], rating: { kind: "human" as const } };
  if (elapsed >= matchmakingQueues.shogi.fillAfterMs)
    return { selected: [oldest], rating: selectShogiCpu(anchor) };
}

const reversi = {
  enabled: (env: Env) => env.REVERSI_MATCHMAKING_ENABLED === "true" && reversiAiEnabled(env),
  store: reversiRatingStore,
  readResult: readReversiRatingResult,
  async readSummary(db: D1Database, accountId: string) {
    return reversiRatingSummarySchema.parse(await readReversiRatingSummary(db, accountId));
  },
  initialRating: shogiInitialRating,
  initialSigma: undefined,
  wideningTimesMs: shogi.wideningTimesMs,
  validParticipants(rating: QueueRatingSource, humans: number) {
    if (rating.kind !== "reversi") return false;
    const { source } = rating;
    const { seats } = matchmakingQueues.reversi;
    return source.kind === "human"
      ? humans === seats
      : humans === seats - 1 && !!reversiCpuProfile(source);
  },
  select<T extends QueueRating>(eligible: T[], elapsed: number) {
    const duel = selectDuel(eligible, elapsed);
    if (!duel) return;
    const { oldest, opponent, anchor } = duel;
    if (opponent)
      return {
        selected: [oldest, opponent],
        rating: { kind: "reversi", source: { kind: "human" } } satisfies ReversiQueueRating,
      };
    if (elapsed >= matchmakingQueues.reversi.fillAfterMs)
      return {
        selected: [oldest],
        rating: { kind: "reversi", source: selectReversiCpu(anchor) } satisfies ReversiQueueRating,
      };
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

const policies = { reversi, shogi, "four-reversi": fourReversi } satisfies Record<
  RatedMatchmakingGame,
  unknown
>;

export function ratedMatchmakingPolicy(game: MatchmakingGame) {
  return policies[game];
}
