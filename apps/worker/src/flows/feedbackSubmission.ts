import type { FeedbackSubmissionStore } from "@tetraboard/context-community";
import {
  deleteFeedbackUpload,
  feedbackSubmissionStore,
} from "../adapters/community/feedbackSubmission";
import { isDeleted } from "../privacy/identity";

export function feedbackSubmissionWithPrivacy(
  db: D1Database,
  bucket: R2Bucket,
): FeedbackSubmissionStore {
  return {
    ...feedbackSubmissionStore(db, bucket),
    async authorWasDeleted(accountId, attachmentKey) {
      if (!(await isDeleted(db, accountId))) return false;
      if (attachmentKey) {
        await db.batch([
          db
            .prepare("INSERT OR IGNORE INTO deletion_images VALUES (?,?)")
            .bind(accountId, attachmentKey),
          db.prepare("UPDATE deleted_accounts SET completed_at_ms=NULL WHERE id=?").bind(accountId),
        ]);
        await bucket.delete(attachmentKey);
      }
      await deleteFeedbackUpload(db, attachmentKey ?? "");
      return true;
    },
  };
}
