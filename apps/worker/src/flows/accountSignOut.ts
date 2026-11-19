import { matchmakingQueueKeys } from "@tetraboard/protocol";
import { readEnteredActiveTournaments } from "../adapters/tournament/queries";

export async function leaveQueuesForSignOut(env: Env, accountId: string) {
  for (const key of matchmakingQueueKeys)
    await env.MATCHMAKING_COORDINATOR.getByName(key).leaveAccount(accountId);
  const tournaments = await readEnteredActiveTournaments(env.APP_DB, accountId);
  // 認証を失効させる前に解除し、別タブの参加確認でも開始できないようにします。
  for (const tournament of tournaments.results)
    await env.TOURNAMENT_COORDINATOR.getByName(tournament.tournament_key).cancelForAccount(
      accountId,
    );
}
