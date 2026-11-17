export function mergedAccountIdSql(accountId: string): string {
  return `COALESCE((SELECT account_id FROM guest_account_merges WHERE guest_id = ${accountId}), ${accountId})`;
}

export function mergedRecordJsonSql(recordJson: string): string {
  // 対応がない場合は、JSONの表記も含めて元の値を保持します。
  return `CASE WHEN EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(${recordJson}) THEN ${recordJson} ELSE '{}' END, '$.participants') p
    JOIN guest_account_merges g ON g.guest_id = json_extract(p.value, '$.accountId')
  ) THEN json_set(${recordJson}, '$.participants', json((
    SELECT json_group_array(json(CASE WHEN g.account_id IS NOT NULL
      THEN json_set(p.value, '$.accountId', g.account_id) ELSE p.value END))
    FROM json_each(${recordJson}, '$.participants') p
    LEFT JOIN guest_account_merges g ON g.guest_id = json_extract(p.value, '$.accountId')
  ))) ELSE ${recordJson} END`;
}
