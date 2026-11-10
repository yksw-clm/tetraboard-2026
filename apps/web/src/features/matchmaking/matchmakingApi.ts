import {
  matchmakingStateSchema,
  shogiRatingResultSchema,
  shogiRatingSummarySchema,
  type MatchmakingGame,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountRequest } from "../account/accountApi";
const api = (game: MatchmakingGame) => `/api/matchmaking/${game}`;
export async function readMatchmaking(
  game: MatchmakingGame,
  controllerId: string,
  signal?: AbortSignal,
) {
  return matchmakingStateSchema.parse(
    await accountRequest(`${api(game)}?controllerId=${encodeURIComponent(controllerId)}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    }),
  );
}
export async function matchmakingOperation(
  game: MatchmakingGame,
  action: "join" | "heartbeat" | "cancel" | "takeover",
  input: { operationId: string; controllerId: string; version?: number },
  signal?: AbortSignal,
) {
  return matchmakingStateSchema.parse(
    await accountRequest(`${api(game)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Legal-Consent": legalVersion },
      body: JSON.stringify(input),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    }),
  );
}

const ratingContracts = {
  shogi: { result: shogiRatingResultSchema, summary: shogiRatingSummarySchema },
} satisfies Record<RatedMatchmakingGame, unknown>;

export async function readRatingResult(
  game: RatedMatchmakingGame,
  matchId: string,
  signal: AbortSignal,
) {
  return ratingContracts[game].result.parse(
    await accountRequest(`${api(game)}/results/${matchId}?includeOpponent=1`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    }),
  );
}

export async function readRatingSummary(game: RatedMatchmakingGame, signal: AbortSignal) {
  return ratingContracts[game].summary.parse(
    await accountRequest(`${api(game)}/rating`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    }),
  );
}
