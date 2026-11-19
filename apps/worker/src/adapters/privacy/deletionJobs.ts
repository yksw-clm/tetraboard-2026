import type { DeletionJob, DeletionJobStore } from "@tetraboard/context-privacy";
import { deletionGuard } from "../../db/deletionGuard";
import { roomDeletionQuery } from "./roomDeletionQuery";

export async function readRoomDeletionAccounts(db: D1Database, roomId: string) {
  const pending = await db.prepare(roomDeletionQuery).bind(roomId).all<{ account_id: string }>();
  return pending.results.map((row) => row.account_id);
}

export async function finishRoomDeletion(db: D1Database, roomId: string, accountId: string) {
  await db
    .prepare("DELETE FROM deletion_rooms WHERE room_id=? AND account_id=?")
    .bind(roomId, accountId)
    .run();
}

export class D1DeletionJobs implements DeletionJobStore {
  constructor(private readonly db: D1Database) {}

  async readJobs(limit: number): Promise<DeletionJob[]> {
    const jobs = await this.db
      .prepare(
        `SELECT id,avatar_key,provider,revocation_token FROM deleted_accounts WHERE completed_at_ms IS NULL ORDER BY last_attempted_at_ms,requested_at_ms LIMIT ${limit}`,
      )
      .all<{
        id: string;
        avatar_key: string | null;
        provider: string | null;
        revocation_token: string | null;
      }>();
    return jobs.results.map((job) => ({
      id: job.id,
      avatarKey: job.avatar_key,
      provider: job.provider,
      revocationToken: job.revocation_token,
    }));
  }

  async recordAttempt(accountId: string, now: number) {
    await this.db
      .prepare("UPDATE deleted_accounts SET last_attempted_at_ms=? WHERE id=?")
      .bind(now, accountId)
      .run();
  }

  async hasRecentAvatarUpload(accountId: string, startedAfter: number) {
    return Boolean(
      await this.db
        .prepare(
          "SELECT 1 FROM privacy_avatar_uploads WHERE account_id=? AND started_at_ms>? LIMIT 1",
        )
        .bind(accountId, startedAfter)
        .first(),
    );
  }

  async readRooms(accountId: string, limit: number) {
    const rooms = await this.db
      .prepare(`SELECT room_id FROM deletion_rooms WHERE account_id=? LIMIT ${limit}`)
      .bind(accountId)
      .all<{ room_id: string }>();
    return rooms.results.map((row) => row.room_id);
  }

  async finishRoom(accountId: string, roomId: string) {
    await this.db
      .prepare("DELETE FROM deletion_rooms WHERE account_id=? AND room_id=?")
      .bind(accountId, roomId)
      .run();
  }

  async hasPendingRooms(accountId: string) {
    return Boolean(
      await this.db
        .prepare("SELECT 1 FROM deletion_rooms WHERE account_id=? LIMIT 1")
        .bind(accountId)
        .first(),
    );
  }

  async clearRevocationToken(accountId: string) {
    await this.db
      .prepare("UPDATE deleted_accounts SET revocation_token=NULL WHERE id=?")
      .bind(accountId)
      .run();
  }

  async completeJob(accountId: string, now: number) {
    // 画像を削除した後に別の処理が予約を追加した場合は、次回の処理対象に残します。
    await this.db
      .prepare(`UPDATE deleted_accounts SET completed_at_ms=?2,avatar_key=NULL,provider=NULL,revocation_token=NULL
        WHERE id=?1 AND completed_at_ms IS NULL
          AND NOT EXISTS(SELECT 1 FROM deletion_images WHERE account_id=?1)`)
      .bind(accountId, now)
      .run();
  }
}

export async function queuePendingDeletionImage(db: D1Database, accountId: string, key: string) {
  const guard = deletionGuard({ accountId });
  await db
    .prepare(`INSERT OR IGNORE INTO deletion_images SELECT ?1,?2 WHERE ${guard.sql}`)
    .bind(...guard.params(key))
    .run();
}

export async function deletePrivacyImages(db: D1Database, bucket: R2Bucket, accountId: string) {
  const images = await db
    .prepare("SELECT key FROM deletion_images WHERE account_id=?")
    .bind(accountId)
    .all<{ key: string }>();
  for (const image of images.results) {
    await bucket.delete(image.key);
    await db
      .prepare("DELETE FROM deletion_images WHERE account_id=? AND key=?")
      .bind(accountId, image.key)
      .run();
  }
}
