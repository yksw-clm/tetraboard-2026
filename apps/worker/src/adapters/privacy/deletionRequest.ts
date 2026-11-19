import {
  acceptedDeletionSql,
  deletionGuard,
  type DeletionBatch,
  type DeletionScope,
} from "../../db/deletionGuard";

export function insertDeletionStatement(
  db: D1Database,
  { accountId, batchReceipt }: DeletionBatch,
  now: number,
) {
  return db
    .prepare(`INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash,avatar_key,provider,revocation_token)
  SELECT u.id,?,?,u.avatarKey,a.providerId,a.accessToken FROM user u LEFT JOIN account a ON a.userId=u.id
  WHERE u.id=? AND NOT EXISTS(SELECT 1 FROM account_room_seats s WHERE s.account_id=u.id)
  AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id) LIMIT 1 RETURNING id`)
    .bind(now, batchReceipt, accountId);
}

export function queueDeletionStatements(
  db: D1Database,
  { accountId, batchReceipt }: DeletionBatch,
) {
  return [
    // 旧実装の席・保存待ちも確認するため、索引の現存行と削除済みの番号を対象に含めます。
    db
      .prepare(
        `INSERT OR IGNORE INTO deletion_rooms SELECT ?1,room_id FROM room_index WHERE ${acceptedDeletionSql}`,
      )
      .bind(accountId, batchReceipt),
    db
      .prepare(
        `INSERT OR IGNORE INTO deletion_rooms SELECT ?1,room_id FROM room_index_deleted_revisions
      WHERE ${acceptedDeletionSql}`,
      )
      .bind(accountId, batchReceipt),
    db
      .prepare(
        `INSERT OR IGNORE INTO deletion_rooms SELECT account_id,room_id FROM privacy_room_accounts
      WHERE account_id=?1 AND ${acceptedDeletionSql}`,
      )
      .bind(accountId, batchReceipt),
    db
      .prepare(`DELETE FROM deletion_flows WHERE account_id=?1 AND ${acceptedDeletionSql}`)
      .bind(accountId, batchReceipt),
    db
      .prepare(`DELETE FROM deletion_challenges WHERE account_id=?1 AND ${acceptedDeletionSql}`)
      .bind(accountId, batchReceipt),
  ];
}

export function queueDeletionImagesStatements(db: D1Database, deletion: DeletionScope) {
  const guard = deletionGuard(deletion);
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO deletion_images SELECT account_id,avatar_key FROM privacy_room_players
      WHERE account_id=?1 AND avatar_key IS NOT NULL AND ${guard.sql}`,
      )
      .bind(...guard.params()),
    db
      .prepare(
        `INSERT OR IGNORE INTO deletion_images SELECT account_id,key FROM privacy_avatar_uploads
      WHERE account_id=?1 AND ${guard.sql}`,
      )
      .bind(...guard.params()),
  ];
}

export function queueRestoredAvatarStatement(db: D1Database, accountId: string, avatarKey: string) {
  const guard = deletionGuard({ accountId });
  return db
    .prepare(`INSERT OR IGNORE INTO deletion_images SELECT id,avatarKey FROM user
    WHERE id=?1 AND avatarKey=?2 AND ${guard.sql}`)
    .bind(...guard.params(avatarKey));
}

export function saveDeletionReceiptStatement(
  db: D1Database,
  { accountId, batchReceipt }: DeletionBatch,
  receiptHash: string,
) {
  return db
    .prepare("UPDATE deleted_accounts SET receipt_hash=?3 WHERE id=?1 AND receipt_hash=?2")
    .bind(accountId, batchReceipt, receiptHash);
}
