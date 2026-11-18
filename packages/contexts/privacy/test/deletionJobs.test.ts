import { expect, test } from "bun:test";
import {
  runDeletionJobs,
  type DeletionJobEffects,
  type DeletionJobStore,
} from "@tetraboard/context-privacy";

test("退会ジョブを順に進め、アップロード中、部屋の残件、失敗のあるジョブは次回へ回す", async () => {
  const jobs = ["uploading", "more-rooms", "purge-failure", "ready"].map((id) => ({
    id,
    avatarKey: null,
    provider: "google",
    revocationToken: "sealed",
  }));
  const events: string[] = [];
  const now = () => 1_000_000;
  const store: DeletionJobStore = {
    async readJobs(limit) {
      events.push(`read-jobs:${limit}`);
      return jobs;
    },
    async recordAttempt(id, attemptedAt) {
      events.push(`attempt:${id}:${attemptedAt}`);
    },
    async hasRecentAvatarUpload(id, startedAfter) {
      events.push(`check-upload:${startedAfter}`);
      return id === "uploading";
    },
    async readRooms(id, limit) {
      events.push(`read-rooms:${limit}`);
      return [`${id}-room`];
    },
    async finishRoom(id, room) {
      events.push(`finish-room:${id}:${room}`);
    },
    async hasPendingRooms(id) {
      return id === "more-rooms";
    },
    async clearRevocationToken(id) {
      events.push(`clear-token:${id}`);
    },
    async completeJob(id, completedAt) {
      events.push(`complete:${id}:${completedAt}`);
    },
  };
  const effects: DeletionJobEffects = {
    async purgeRoom(id, room) {
      events.push(`purge-room:${id}:${room}`);
      if (id === "purge-failure") throw new Error("Room unavailable");
    },
    async purgeMatchmaking(id) {
      events.push(`purge-matchmaking:${id}`);
    },
    async purgeTournaments(id) {
      events.push(`purge-tournaments:${id}`);
    },
    async deleteFeedback(id) {
      events.push(`delete-feedback:${id}`);
    },
    async deleteImages(job) {
      events.push(`delete-images:${job.id}`);
    },
    async revokeProviderToken(provider, token) {
      events.push(`revoke:${provider}:${token}`);
    },
    async deleteAccountData(id) {
      events.push(`delete-account:${id}`);
    },
    reportRetry() {
      events.push("retry");
    },
  };

  await runDeletionJobs(store, effects, now);

  expect(events).toEqual([
    "read-jobs:10",
    "attempt:uploading:1000000",
    "check-upload:400000",
    "attempt:more-rooms:1000000",
    "check-upload:400000",
    "read-rooms:100",
    "purge-room:more-rooms:more-rooms-room",
    "finish-room:more-rooms:more-rooms-room",
    "attempt:purge-failure:1000000",
    "check-upload:400000",
    "read-rooms:100",
    "purge-room:purge-failure:purge-failure-room",
    "retry",
    "attempt:ready:1000000",
    "check-upload:400000",
    "read-rooms:100",
    "purge-room:ready:ready-room",
    "finish-room:ready:ready-room",
    "purge-matchmaking:ready",
    "purge-tournaments:ready",
    "delete-feedback:ready",
    "delete-images:ready",
    "revoke:google:sealed",
    "clear-token:ready",
    "delete-account:ready",
    "complete:ready:1000000",
  ]);
});
