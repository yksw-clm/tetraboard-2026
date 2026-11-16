import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import type { PendingRoomIndex } from "../../rooms/roomIndex";
import type { PurgeTargets } from "./types";
import { collectMatchPlayers, rememberMatchPlayer } from "./identityScope";
const pendingIndexKey = "room-index-pending";

export async function loadPurgeTargets(
  runtime: RoomRuntime,
  accountId: string,
): Promise<PurgeTargets> {
  await runtime.syncAlarm();
  const aliases = await runtime.db
    .prepare("SELECT guest_id FROM guest_account_merges WHERE account_id=?")
    .bind(accountId)
    .all<{ guest_id: string }>();
  const accountIds = new Set([accountId, ...aliases.results.map((row) => row.guest_id)]);
  const entries = [...runtime.ctx.storage.kv.list<unknown>()];
  const ids = new Set<string>();
  const names = new Set<string>();
  const matchPlayers = new Map<string, Set<string>>();
  const targets: PurgeTargets = {
    accountId,
    accountIds,
    entries,
    ids,
    names,
    matchPlayers,
    found: false,
  };
  await loadRetainedPlayers(runtime, targets);
  // 同じ席IDでも、登録前の別の局へ本人情報を遡及させません。
  for (const [, value] of entries) collectMatchPlayers(runtime, targets, value);
  return targets;
}

async function loadRetainedPlayers(runtime: RoomRuntime, targets: PurgeTargets) {
  const { accountId, ids } = targets;
  const code =
    runtime.ctx.id.name ??
    runtime.readRoom()?.id ??
    runtime.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey)?.metadata.id;
  if (code) {
    await runtime.syncAlarm();
    const retained = await runtime.db
      .prepare("SELECT player_id FROM privacy_room_players WHERE account_id=? AND room_id=?")
      .bind(accountId, code)
      .all<{ player_id: string }>();
    for (const row of retained.results) ids.add(row.player_id);
    await runtime.syncAlarm();
    const matchIdentities = await runtime.db
      .prepare(`
          SELECT m.id AS match_id, json_extract(p.value, '$.id') AS player_id
          FROM matches m, json_each(m.record_json, '$.participants') p
          WHERE json_extract(m.record_json, '$.roomId')=? AND (
            json_extract(p.value, '$.accountId')=? OR
            (json_extract(p.value, '$.retired')=1 AND EXISTS (
              SELECT 1 FROM privacy_room_players r WHERE r.account_id=? AND r.room_id=?
                AND r.instance_id=json_extract(m.record_json, '$.instanceId')
                AND r.player_id=json_extract(p.value, '$.id'))))
          UNION SELECT match_id,player_id FROM match_participant_accounts
          WHERE room_id=? AND state='retired'`)
      .bind(code, accountId, accountId, code, code)
      .all<{ match_id: string; player_id: string }>();
    for (const row of matchIdentities.results)
      rememberMatchPlayer(runtime, targets, row.match_id, row.player_id);
  }
}
