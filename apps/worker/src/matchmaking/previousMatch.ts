import {
  matchmakingQueues,
  ratedMatchmakingGameIds,
  type MatchmakingState,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { ratedMatchmakingPolicy } from "./ratedMatchmaking";

export const pendingRatedGames = ratedMatchmakingGameIds.map((game) => ({
  game,
  table: ratedMatchmakingPolicy(game).store.pendingTable,
}));

export const noPendingRatedMatch = pendingRatedGames
  .map(({ table }) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE account_id=?5)`)
  .join(" AND ");

export const recoverableFourReversiPending = `EXISTS (
  SELECT 1 FROM analytics_matches a WHERE a.id=pending.match_id
    AND a.game='four-reversi' AND a.status='abandoned' AND a.cpu_count>0
) AND NOT EXISTS (SELECT 1 FROM matches WHERE id=pending.match_id)`;

export async function readPreviousRatedMatch(
  env: Env,
  accountId: string,
  game: RatedMatchmakingGame,
): Promise<MatchmakingState["previousMatch"]> {
  const ordered = [...pendingRatedGames].sort(
    (a, b) => Number(b.game === game) - Number(a.game === game),
  );
  const pending = await env.APP_DB.prepare(
    ordered
      .map(
        ({ game, table }) =>
          `SELECT '${game}' AS game, match_id, room_id, instance_id FROM ${table} AS pending WHERE account_id=?1${game === "four-reversi" ? ` AND NOT (${recoverableFourReversiPending})` : ""}`,
      )
      .join(" UNION ALL ") + " LIMIT 1",
  )
    .bind(accountId)
    .first<{
      game: RatedMatchmakingGame;
      match_id: string;
      room_id: string | null;
      instance_id: string | null;
    }>();
  if (!pending) return;
  const previous = { game: pending.game, matchId: pending.match_id };
  try {
    const reference =
      pending.room_id && pending.instance_id
        ? { roomId: pending.room_id, instanceId: pending.instance_id }
        : await env.MATCHMAKING_COORDINATOR.getByName(
            matchmakingQueues[pending.game].key,
          ).previousRoom(accountId, pending.match_id);
    if (!reference) return { ...previous, phase: "unavailable" };
    const state = await env.GAME_ROOM.getByName(reference.roomId).getMatchmakingState(
      pending.match_id,
      reference.instanceId,
    );
    if (!state.room) return { ...previous, phase: "saving" };
    return {
      ...previous,
      phase: state.room.status === "playing" ? "playing" : state.started ? "saving" : "matched",
      room: state.room,
    };
  } catch {
    return { ...previous, phase: "unavailable" };
  }
}
