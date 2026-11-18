type ExpiredFeedback = { id: string; attachmentKey: string | null };

export interface FeedbackCleanupStore {
  findExpired(now: number, pendingBefore: number): Promise<ExpiredFeedback[]>;
  hide(id: string): Promise<void>;
  deleteAttachment(key: string): Promise<void>;
  deleteFeedback(id: string, attachmentKey: string | null): Promise<void>;
  findOrphanAttachments(before: number): Promise<string[]>;
  deleteUpload(key: string): Promise<void>;
  deleteExpiredLimits(now: number): Promise<void>;
}

export async function purgeExpiredFeedback(store: FeedbackCleanupStore, now: number) {
  const pendingBefore = now - 86400000;
  // 閲覧対象から先に外し、R2削除が完了するまでD1を残して次回も再試行できます。
  for (const row of await store.findExpired(now, pendingBefore)) {
    await store.hide(row.id);
    try {
      if (row.attachmentKey) await store.deleteAttachment(row.attachmentKey);
      await store.deleteFeedback(row.id, row.attachmentKey);
    } catch {
      /* 次の毎時処理で再試行します。投稿内容をログに記録しません。 */
    }
  }
  for (const key of await store.findOrphanAttachments(pendingBefore)) {
    try {
      await store.deleteAttachment(key);
      await store.deleteUpload(key);
    } catch {
      /* 再試行 */
    }
  }
  await store.deleteExpiredLimits(now);
}
