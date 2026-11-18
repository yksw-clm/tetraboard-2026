import { retiredName } from "../../privacy/identity";

export function scrubbedRecordJsonSql(recordJson: string, matchId: string): string {
  // 統合後の JSON は一度だけ評価し、伏せ字の対象がなければ元の表記を保持します。
  return `(WITH scrub_input(record_json, match_id) AS MATERIALIZED (
    SELECT ${recordJson}, ${matchId}
  )
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM match_participant_accounts c WHERE c.match_id = s.match_id AND c.state = 'retired'
  ) OR EXISTS (
    SELECT 1
    FROM json_each(CASE WHEN json_valid(s.record_json) THEN s.record_json ELSE '{}' END, '$.participants') p
    JOIN deleted_accounts d ON d.id = json_extract(p.value, '$.accountId')
  ) THEN json_set(s.record_json, '$.participants', json((
    SELECT json_group_array(json(CASE WHEN EXISTS (
      SELECT 1 FROM match_participant_accounts c
      WHERE c.match_id = s.match_id AND c.player_id = json_extract(p.value, '$.id') AND c.state = 'retired'
    ) OR EXISTS (
      SELECT 1 FROM deleted_accounts d WHERE d.id = json_extract(p.value, '$.accountId')
    ) THEN json_set(p.value, '$.name', '${retiredName}', '$.accountId', NULL, '$.retired', json('true'))
      ELSE p.value END))
    FROM json_each(s.record_json, '$.participants') p
  ))) ELSE s.record_json END
  FROM scrub_input s)`;
}

// 引き継ぎを retired にする文の直後に、同じ batch で実行します。
export function scrubRetiredMatchClaimStatements(
  db: D1Database,
  matchId: string,
  playerId: string,
) {
  const recordJson = scrubbedRecordJsonSql("record_json", "?1");
  const where = `id = ?1 AND EXISTS (
    SELECT 1 FROM match_participant_accounts c
    WHERE c.match_id = ?1 AND c.player_id = ?2 AND c.state = 'retired'
  )`;
  return [
    db
      .prepare(`UPDATE matches SET record_json = ${recordJson} WHERE ${where}`)
      .bind(matchId, playerId),
    db
      .prepare(`UPDATE match_uploads SET record_json = ${recordJson} WHERE ${where}`)
      .bind(matchId, playerId),
  ];
}
