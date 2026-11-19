// ?1 は退会対象の ID です。受付値は文固有の値より後ろに置きます。
export const acceptedDeletionSql =
  "EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?1 AND receipt_hash=?)";
const pendingDeletionSql =
  "EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?1 AND completed_at_ms IS NULL)";

export type DeletionBatch = { accountId: string; batchReceipt: string };
export type DeletionScope = { accountId: string; batchReceipt?: string };

export function deletionGuard({ accountId, batchReceipt }: DeletionScope) {
  return {
    sql: batchReceipt === undefined ? pendingDeletionSql : acceptedDeletionSql,
    params: (...values: string[]) =>
      batchReceipt === undefined ? [accountId, ...values] : [accountId, ...values, batchReceipt],
  };
}

export function deletedAccountExistsSql(accountId: string) {
  return `EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=${accountId})`;
}

export function accountNotDeletedSql(accountId: string) {
  return `NOT ${deletedAccountExistsSql(accountId)}`;
}
