export function roomHostAccountExistsSql(
  roomId: string,
  instanceId: string,
  hostPlayerId: string,
  accountCondition: string,
) {
  return `EXISTS (
    SELECT 1 FROM privacy_room_players r
    WHERE r.room_id=${roomId} AND r.instance_id=${instanceId}
      AND r.player_id=${hostPlayerId} AND (${accountCondition})
  )`;
}

export function roomParticipantScrubSql(roomId: string, instanceId: string, participants: string) {
  const retiredParticipant = `json_extract(p.value,'$.appearance.kind')='human' AND EXISTS (
    SELECT 1 FROM privacy_room_players r JOIN deleted_accounts d
      ON d.id=r.account_id OR EXISTS (
        SELECT 1 FROM guest_account_merges m WHERE m.guest_id=r.account_id AND m.account_id=d.id
      )
    WHERE r.room_id=${roomId} AND r.instance_id=${instanceId}
      AND r.player_id=json_extract(p.value,'$.playerId')
  )`;

  return {
    needed: `${participants} IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(${participants}) p WHERE ${retiredParticipant}
        AND (json_extract(p.value,'$.appearance.avatarUrl') IS NOT NULL
          OR COALESCE(json_extract(p.value,'$.appearance.retired'),0)<>1)
    )`,
    scrubbed: `(
      SELECT json_group_array(json(CASE WHEN ${retiredParticipant}
        THEN json_set(p.value,'$.appearance.avatarUrl',NULL,'$.appearance.retired',json('true'))
        ELSE p.value END)) FROM json_each(${participants}) p
    )`,
  };
}
