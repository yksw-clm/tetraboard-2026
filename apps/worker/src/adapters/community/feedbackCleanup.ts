import { purgeExpiredFeedback, type FeedbackCleanupStore } from "@tetraboard/context-community";
import { deleteFeedbackUpload } from "./feedbackSubmission";

function feedbackCleanupStore(db: D1Database, bucket: R2Bucket): FeedbackCleanupStore {
  return {
    async findExpired(now, pendingBefore) {
      const rows = await db
        .prepare(
          "SELECT id, attachment_key FROM feedback WHERE deleted = 1 OR expires_at_ms <= ? OR (ready = 0 AND received_at_ms <= ?) LIMIT 100",
        )
        .bind(now, pendingBefore)
        .all<{ id: string; attachment_key: string | null }>();
      return rows.results.map((row) => ({ id: row.id, attachmentKey: row.attachment_key }));
    },
    async hide(id) {
      await db.prepare("UPDATE feedback SET deleted = 1 WHERE id = ?").bind(id).run();
    },
    deleteAttachment: (key) => bucket.delete(key),
    async deleteFeedback(id, attachmentKey) {
      await db.batch([
        db.prepare("DELETE FROM feedback_history WHERE feedback_id = ?").bind(id),
        db.prepare("DELETE FROM feedback WHERE id = ? AND deleted = 1").bind(id),
        db.prepare("DELETE FROM feedback_uploads WHERE key = ?").bind(attachmentKey ?? ""),
      ]);
    },
    async findOrphanAttachments(before) {
      const rows = await db
        .prepare(
          "SELECT key FROM feedback_uploads WHERE created_at_ms <= ? AND NOT EXISTS (SELECT 1 FROM feedback WHERE attachment_key = feedback_uploads.key) LIMIT 100",
        )
        .bind(before)
        .all<{ key: string }>();
      return rows.results.map((row) => row.key);
    },
    deleteUpload: (key) => deleteFeedbackUpload(db, key),
    async deleteExpiredLimits(now) {
      await db.prepare("DELETE FROM feedback_limits WHERE expires_at_ms <= ?").bind(now).run();
    },
  };
}

export async function cleanupFeedback(
  env: { APP_DB: D1Database; OBJECT_STORAGE: R2Bucket },
  now = Date.now(),
) {
  await purgeExpiredFeedback(feedbackCleanupStore(env.APP_DB, env.OBJECT_STORAGE), now);
}
