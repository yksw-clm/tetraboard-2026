import {
  isRatedMatchmakingGame,
  matchmakingQueues,
  shogiRatingSummarySchema,
  type MatchmakingGame,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { shogiAiEnabled } from "../rooms/aiService";
import {
  readShogiRatingResult,
  readShogiRatingSummary,
  shogiInitialRating,
  shogiRatingStore,
  type ShogiRatingSource,
} from "../rooms/shogiRating";
import { selectShogiCpu, shogiCpuNodes } from "./shogiCpuProfiles";

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
  wideningTimesMs: widening.map(({ afterMs }) => afterMs),
  validParticipants(rating: ShogiRatingSource, humans: number) {
    const seats = matchmakingQueues.shogi.seats;
    return rating.kind === "human"
      ? humans === seats
      : humans === seats - 1 && shogiCpuNodes(rating.profileId) !== undefined;
  },
  select<T extends { rating?: number }>(eligible: T[], elapsed: number) {
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

const policies = { shogi } satisfies Record<RatedMatchmakingGame, unknown>;

export function ratedMatchmakingPolicy(game: MatchmakingGame) {
  return isRatedMatchmakingGame(game) ? policies[game] : undefined;
}
