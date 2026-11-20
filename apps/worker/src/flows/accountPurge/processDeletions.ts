import { runDeletionJobs } from "@tetraboard/context-privacy";
import { matchmakingQueueKeys } from "@tetraboard/protocol";
import type { AuthEnv } from "../../adapters/account/auth";
import { avatarKeyPattern } from "../../adapters/account/profilePolicy";
import { D1DeletionJobs, deletePrivacyImages } from "../../adapters/privacy/deletionJobs";
import { revokeProviderToken } from "../../adapters/privacy/revokeProviderToken";
import { reapplyDeletionCascade } from "./deletionCascade";
import { deleteAccountData, deleteFeedback, purgeTournaments } from "./deletionCleanup";

export function processDeletions(env: AuthEnv) {
  return runDeletionJobs(
    new D1DeletionJobs(env.APP_DB),
    {
      reapplyDeletion: (accountId) => reapplyDeletionCascade(env, accountId),
      async purgeRoom(accountId, roomId) {
        await env.GAME_ROOM.getByName(roomId).purgeAccount(accountId);
      },
      async purgeMatchmaking(accountId) {
        for (const key of matchmakingQueueKeys)
          await env.MATCHMAKING_COORDINATOR.getByName(key).purgeAccount(accountId);
      },
      purgeTournaments: (accountId) => purgeTournaments(env, accountId),
      deleteFeedback: (accountId) => deleteFeedback(env, accountId),
      async deleteImages(job) {
        if (job.avatarKey && avatarKeyPattern.test(job.avatarKey))
          await env.OBJECT_STORAGE.delete(job.avatarKey);
        await deletePrivacyImages(env.APP_DB, env.OBJECT_STORAGE, job.id);
      },
      revokeProviderToken: (provider, token) => revokeProviderToken(env, provider, token),
      deleteAccountData: (accountId) => deleteAccountData(env, accountId),
      reportRetry: () => console.error("Account deletion will be retried"),
    },
    Date.now,
  );
}
