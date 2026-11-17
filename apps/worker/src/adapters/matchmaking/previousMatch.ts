import { readPendingRating } from "@tetraboard/context-rating";
import { previousMatch } from "@tetraboard/context-matchmaking";
import { D1RatingReader } from "../rating/reader";
import {
  matchmakingQueues,
  ratedMatchmakingGameIds,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { ratedMatchmakingPolicy } from "./ratedMatchmaking";
export const pendingRatedGames = ratedMatchmakingGameIds.map((game) => ({
  game,
  table: ratedMatchmakingPolicy(game).store.pendingTable,
}));

export function noPendingRatedMatch(accountId: string) {
  const clauses = pendingRatedGames.map(({ game, table }) => ({
    sql: `NOT EXISTS (SELECT 1 FROM ${table} WHERE game='${game}' AND account_id=?)`,
    value: accountId,
  }));
  return {
    sql: clauses.map(({ sql }) => sql).join(" AND "),
    values: clauses.map(({ value }) => value),
  };
}

export function readPreviousRatedMatch(env: Env, accountId: string, game: RatedMatchmakingGame) {
  return previousMatch(
    {
      pending: (accountId, game) =>
        readPendingRating(new D1RatingReader(env.APP_DB), accountId, game, ratedMatchmakingGameIds),
      previousRoom: (accountId, pending) =>
        env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[pending.game].key).previousRoom(
          accountId,
          pending.match_id,
        ),
      roomState: (roomId, matchId, instanceId) =>
        env.GAME_ROOM.getByName(roomId).getMatchmakingState(matchId, instanceId),
    },
    accountId,
    game,
  );
}
