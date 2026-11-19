import {
  fourReversiRatingSummarySchema,
  matchmakingQueues,
  shogiRatingSummarySchema,
  reversiRatingSummarySchema,
  type MatchmakingGame,
} from "@tetraboard/protocol";
import { aiServiceConfigured } from "../room/ai/aiService";
import { reversiAiEnabled } from "../room/ai/reversiAi";
import { shogiAiEnabled } from "../room/ai/shogiAi";
import {
  readShogiRatingResult,
  readShogiRatingSummary,
  shogiInitialRating,
  shogiRatingStore,
} from "../../rooms/shogiRating";
import { reversiCpuProfile, selectReversiCpu } from "./reversiCpuProfiles";
import {
  readReversiRatingResult,
  readReversiRatingSummary,
  reversiRatingStore,
} from "../../rooms/reversiRating";

import { initialFourReversiRating } from "@tetraboard/context-rating";
import {
  fourShogiRatingStore,
  readFourShogiRatingResult,
  readFourShogiRatingSummary,
  fourReversiRatingStore,
  readFourReversiRatingResult,
  readFourReversiRatingSummary,
} from "../../rooms/fourReversiRating";
import {
  calibratedFourReversiProfile,
  hasCalibratedFourReversiProfiles,
  selectFourReversi,
} from "./fourReversiSelection";

import { calibratedFourShogiProfile, selectFourShogi } from "./fourShogiSelection";

import { createRatedMatchmakingPolicies } from "@tetraboard/context-matchmaking";
const policies = createRatedMatchmakingPolicies({
  queues: matchmakingQueues,
  shogiInitialRating,
  initialFourReversiRating,
  calibratedFourReversiProfile,
  calibratedFourShogiProfile,
  hasCalibratedFourReversiProfiles,
  selectFourReversi,
  selectFourShogi,
  reversiCpuProfile,
  selectReversiCpu,
});
const shellPolicies = {
  shogi: {
    ...policies["shogi"],
    enabled: (env: Env) => env.SHOGI_MATCHMAKING_ENABLED === "true" && shogiAiEnabled(env),
    store: shogiRatingStore,
    readResult: readShogiRatingResult,
    async readSummary(db: D1Database, accountId: string) {
      return shogiRatingSummarySchema.parse(await readShogiRatingSummary(db, accountId));
    },
  },
  reversi: {
    ...policies["reversi"],
    enabled: (env: Env) => env.REVERSI_MATCHMAKING_ENABLED === "true" && reversiAiEnabled(env),
    store: reversiRatingStore,
    readResult: readReversiRatingResult,
    async readSummary(db: D1Database, accountId: string) {
      return reversiRatingSummarySchema.parse(await readReversiRatingSummary(db, accountId));
    },
  },
  "four-reversi": {
    ...policies["four-reversi"],
    enabled: (env: Env) =>
      env.MATCHMAKING_ENABLED === "true" &&
      aiServiceConfigured(env) &&
      hasCalibratedFourReversiProfiles(),
    store: fourReversiRatingStore,
    readResult: readFourReversiRatingResult,
    async readSummary(db: D1Database, accountId: string) {
      return fourReversiRatingSummarySchema.parse(
        await readFourReversiRatingSummary(db, accountId),
      );
    },
  },
  "four-shogi": {
    ...policies["four-shogi"],
    enabled: (env: Env) =>
      env.FOUR_SHOGI_MATCHMAKING_ENABLED === "true" && aiServiceConfigured(env),
    store: fourShogiRatingStore,
    readResult: readFourShogiRatingResult,
    async readSummary(db: D1Database, accountId: string) {
      return fourReversiRatingSummarySchema.parse(await readFourShogiRatingSummary(db, accountId));
    },
  },
};
export function ratedMatchmakingPolicy(game: MatchmakingGame) {
  return shellPolicies[game];
}
