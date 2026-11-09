import {
  matchmakingStateSchema,
  shogiRatingResultSchema,
  shogiRatingSummarySchema,
  type MatchmakingGame,
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

export async function readShogiRatingResult(matchId: string, signal: AbortSignal) {
  return shogiRatingResultSchema.parse(
    await accountRequest(`${api("shogi")}/results/${matchId}?includeOpponent=1`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    }),
  );
}

export async function readShogiRatingSummary(signal: AbortSignal) {
  return shogiRatingSummarySchema.parse(
    await accountRequest(`${api("shogi")}/rating`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    }),
  );
}
