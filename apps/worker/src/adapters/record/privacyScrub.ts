import { retiredName } from "@tetraboard/context-privacy";
import { acceptedDeletionSql, type DeletionBatch } from "../../db/deletionGuard";

export function scrubbedRecordJsonSql(
  recordJson: string,
  matchId: string,
  retiredClaim = "c.state = 'retired'",
): string {
  // 統合後の JSON は一度だけ評価し、伏せ字の対象がなければ元の表記を保持します。
  return `(WITH scrub_input(record_json, match_id) AS MATERIALIZED (
    SELECT ${recordJson}, ${matchId}
  )
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM match_participant_accounts c WHERE c.match_id = s.match_id AND (${retiredClaim})
  ) OR EXISTS (
    SELECT 1
    FROM json_each(CASE WHEN json_valid(s.record_json) THEN s.record_json ELSE '{}' END, '$.participants') p
    JOIN deleted_accounts d ON d.id = json_extract(p.value, '$.accountId')
  ) THEN json_set(s.record_json, '$.participants', json((
    SELECT json_group_array(json(CASE WHEN EXISTS (
      SELECT 1 FROM match_participant_accounts c
      WHERE c.match_id = s.match_id AND c.player_id = json_extract(p.value, '$.id') AND (${retiredClaim})
    ) OR EXISTS (
      SELECT 1 FROM deleted_accounts d WHERE d.id = json_extract(p.value, '$.accountId')
    ) THEN json_set(p.value, '$.name', '${retiredName}', '$.accountId', NULL, '$.retired', json('true'))
      ELSE p.value END))
    FROM json_each(s.record_json, '$.participants') p
  ))) ELSE s.record_json END
  FROM scrub_input s)`;
}

function scrubRecordStatements(
  db: D1Database,
  where: string,
  params: string[],
  retiredClaim?: string,
) {
  const recordJson = scrubbedRecordJsonSql("record_json", "record.id", retiredClaim);
  return [
    db
      .prepare(`UPDATE matches AS record SET record_json = ${recordJson} WHERE ${where}`)
      .bind(...params),
    db
      .prepare(`UPDATE match_uploads AS record SET record_json = ${recordJson} WHERE ${where}`)
      .bind(...params),
  ];
}

// 席を指定する場合は、引き継ぎを retired にする文の直後に実行します。
export function scrubRetiredMatchClaimStatements(
  db: D1Database,
  ...target: [matchId: string, playerId: string] | [deletion: DeletionBatch]
) {
  if (target.length === 2)
    return scrubRecordStatements(
      db,
      `record.id = ?1 AND EXISTS (
        SELECT 1 FROM match_participant_accounts c
        WHERE c.match_id = ?1 AND c.player_id = ?2 AND c.state = 'retired'
      )`,
      target,
    );

  // 退会のときは、同じ batch で引き継ぎを失効させる直前の account_id で席を絞ります。
  const [{ accountId, batchReceipt }] = target;
  return scrubRecordStatements(
    db,
    `${acceptedDeletionSql} AND record.id IN (
      SELECT match_id FROM match_participant_accounts WHERE account_id = ?1
    )`,
    [accountId, batchReceipt],
    "c.state = 'retired' OR c.account_id = ?1",
  );
}

export function scrubDeletedAccountRecordsStatements(db: D1Database, deletion: DeletionBatch) {
  const { accountId, batchReceipt } = deletion;
  const directParticipant = `EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(record.record_json) THEN record.record_json ELSE '{}' END, '$.participants') p
    WHERE json_extract(p.value, '$.accountId') = ?1
  )`;
  return [
    ...scrubRecordStatements(db, `${acceptedDeletionSql} AND ${directParticipant}`, [
      accountId,
      batchReceipt,
    ]),
    db
      .prepare(`DELETE FROM account_match_history WHERE account_id=?1 AND ${acceptedDeletionSql}`)
      .bind(accountId, batchReceipt),
  ];
}
