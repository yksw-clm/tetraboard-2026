import {
  deletionAvatarUploadWindowMs,
  deletionJobLimit,
  deletionRoomLimit,
} from "../domain/deletion";

export interface DeletionJob {
  id: string;
  avatarKey: string | null;
  provider: string | null;
  revocationToken: string | null;
}

export interface DeletionJobStore {
  readJobs(limit: number): Promise<DeletionJob[]>;
  recordAttempt(accountId: string, now: number): Promise<void>;
  hasRecentAvatarUpload(accountId: string, startedAfter: number): Promise<boolean>;
  readRooms(accountId: string, limit: number): Promise<string[]>;
  finishRoom(accountId: string, roomId: string): Promise<void>;
  hasPendingRooms(accountId: string): Promise<boolean>;
  clearRevocationToken(accountId: string): Promise<void>;
  completeJob(accountId: string, now: number): Promise<void>;
}

export interface DeletionJobEffects {
  reapplyDeletion(accountId: string): Promise<void>;
  purgeRoom(accountId: string, roomId: string): Promise<void>;
  purgeMatchmaking(accountId: string): Promise<void>;
  purgeTournaments(accountId: string): Promise<void>;
  deleteFeedback(accountId: string): Promise<void>;
  deleteImages(job: DeletionJob): Promise<void>;
  revokeProviderToken(provider: string | null, token: string | null): Promise<void>;
  deleteAccountData(accountId: string): Promise<void>;
  reportRetry(): void;
}

export async function runDeletionJobs(
  store: DeletionJobStore,
  effects: DeletionJobEffects,
  now: () => number,
) {
  const jobs = await store.readJobs(deletionJobLimit);
  for (const job of jobs) {
    try {
      await store.recordAttempt(job.id, now());
      await effects.reapplyDeletion(job.id);
      if (await store.hasRecentAvatarUpload(job.id, now() - deletionAvatarUploadWindowMs)) continue;
      for (const roomId of await store.readRooms(job.id, deletionRoomLimit)) {
        await effects.purgeRoom(job.id, roomId);
        await store.finishRoom(job.id, roomId);
      }
      if (await store.hasPendingRooms(job.id)) continue;

      await effects.purgeMatchmaking(job.id);
      await effects.purgeTournaments(job.id);
      await effects.deleteFeedback(job.id);
      await effects.deleteImages(job);
      await effects.revokeProviderToken(job.provider, job.revocationToken);
      await store.clearRevocationToken(job.id);
      await effects.deleteAccountData(job.id);
      await store.completeJob(job.id, now());
    } catch {
      effects.reportRetry();
    }
  }
}
