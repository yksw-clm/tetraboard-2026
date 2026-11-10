import {
  matchmakingStateSchema,
  fourReversiRatingResultSchema,
  fourReversiRatingSummarySchema,
  reversiRatingResultSchema,
  reversiRatingSummarySchema,
  shogiRatingResultSchema,
  shogiRatingSummarySchema,
  type MatchmakingGame,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountRequest } from "../account/accountApi";
const api = (game: MatchmakingGame) => `/api/matchmaking/${game}`;
const waitingQuery = (game: MatchmakingGame) =>
  game === "four-reversi" ? "rated=1&waitingCount=1" : "waitingCount=1";
export type ObservedMatchmaking = ReturnType<typeof matchmakingStateSchema.parse> & {
  legacy?: true;
};

export async function readRatedAvailability(game: RatedMatchmakingGame, signal: AbortSignal) {
  return (
    matchmakingStateSchema.parse(
      await accountRequest(api(game), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      }),
    ).enabled === true
  );
}

export async function readMatchmaking(
  game: MatchmakingGame,
  controllerId: string,
  signal?: AbortSignal,
  legacy = false,
): Promise<ObservedMatchmaking> {
  const state = matchmakingStateSchema.parse(
    await accountRequest(
      `${api(game)}?controllerId=${encodeURIComponent(controllerId)}${legacy ? "" : `&${waitingQuery(game)}`}`,
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      },
    ),
  );
  return legacy ? { ...state, legacy: true } : state;
}
export async function matchmakingOperation(
  game: MatchmakingGame,
  action: "join" | "heartbeat" | "cancel" | "takeover",
  input: { operationId: string; controllerId: string; version?: number },
  signal?: AbortSignal,
  legacy = false,
): Promise<ObservedMatchmaking> {
  const state = matchmakingStateSchema.parse(
    await accountRequest(`${api(game)}/${action}${legacy ? "" : `?${waitingQuery(game)}`}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Legal-Consent": legalVersion },
      body: JSON.stringify(input),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    }),
  );
  return legacy ? { ...state, legacy: true } : state;
}

const ratingContracts = {
  "four-shogi": { result: fourReversiRatingResultSchema, summary: fourReversiRatingSummarySchema },
  "four-reversi": {
    result: fourReversiRatingResultSchema,
    summary: fourReversiRatingSummarySchema,
  },
  reversi: { result: reversiRatingResultSchema, summary: reversiRatingSummarySchema },
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
