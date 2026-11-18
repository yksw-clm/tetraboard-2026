// ?1 と ?2 は退会対象の ID と今回の batch だけで使う受付値です。
export const acceptedDeletionSql =
  "EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?1 AND receipt_hash=?2)";

export type DeletionBatch = { accountId: string; batchReceipt: string };
