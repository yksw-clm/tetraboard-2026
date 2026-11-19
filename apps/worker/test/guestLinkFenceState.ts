import type { GuestFenceFixture } from "./guestFenceFixtures";
import { tournamentFixture } from "./guestFenceFixtures";

export async function readGuestLinkState(db: D1Database) {
  const { results: tables } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
    )
    .all<{ name: string }>();
  const rows = await db.batch(
    tables.map(({ name }) =>
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`),
    ),
  );
  return Object.fromEntries(rows.map(({ results }, i) => [tables[i]!.name, results]));
}

export async function seedGuestTransfers(
  db: D1Database,
  fixture: GuestFenceFixture,
  player: { roomId: string; instanceId: string; matchId: string; playerId: string },
) {
  const { guest, target } = fixture;
  const { roomId, instanceId, matchId, playerId } = player;
  const key = await tournamentFixture(db);
  const entry = crypto.randomUUID();
  const record = JSON.stringify({
    participants: [{ id: playerId, kind: "human", accountId: guest.id }],
  });
  const message = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(`INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt)
      VALUES(?,?,'google',?,?,?)`)
      .bind(target.id, target.id, target.id, now, now),
    db
      .prepare(`INSERT INTO feedback(id,submission_id,payload_hash,author,reporter_hash,internal,
      kind,game,body,expectation,steps,received_at_ms,expires_at_ms,account_id)
      VALUES(?,?,'hash','ゲスト','reporter',0,'bug','all','本文','','',1,2,?)`)
      .bind(matchId, matchId, guest.id),
    db
      .prepare(`INSERT INTO matches(id,game,mode,started_at_ms,ended_at_ms,record_json)
      VALUES(?,'four-reversi','singles',1,2,?)`)
      .bind(matchId, record),
    db
      .prepare(`INSERT INTO match_uploads(id,record_json,chunk_count,event_count)
      VALUES(?,?,0,0)`)
      .bind(matchId, record),
    db
      .prepare(`INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game)
      VALUES(?,?,'singles',1,'four-reversi')`)
      .bind(guest.id, matchId),
    db
      .prepare(`INSERT INTO match_participant_accounts VALUES(?,?,?,?,?,'applied',1,1)`)
      .bind(matchId, playerId, guest.id, roomId, instanceId),
    db
      .prepare("INSERT INTO lobby_chat_senders(account_id,public_id,last_sent_at_ms) VALUES(?,?,1)")
      .bind(guest.id, guest.id),
    db
      .prepare(`INSERT INTO lobby_chat_messages(id,account_id,body,sent_at_ms,request_id,body_hash)
      VALUES(?,?,'本文',1,?,'hash')`)
      .bind(message, guest.id, requestId),
    db
      .prepare(`INSERT INTO lobby_chat_requests(account_id,request_id,message_id,body_hash,sent_at_ms)
      VALUES(?,?,?,'hash',1)`)
      .bind(guest.id, requestId, message),
    db
      .prepare(`INSERT INTO lobby_chat_reports(id,message_id,sender_account_id,sender_name,
      body,sent_at_ms,reporter_account_id,reported_at_ms) VALUES(?,?,?,'ゲスト','本文',1,?,1)`)
      .bind(message, message, guest.id, guest.id),
    db.prepare("INSERT INTO account_notification_state VALUES(?,0,0)").bind(guest.id),
    db
      .prepare(
        "INSERT INTO notification_events(kind,source_id,account_id,created_at_ms) VALUES('badge',?,?,1)",
      )
      .bind(matchId, guest.id),
    db
      .prepare(
        "INSERT INTO account_notification_reads SELECT ?,seq FROM notification_events WHERE account_id=?",
      )
      .bind(guest.id, guest.id),
    db.prepare("INSERT INTO tournament_entries VALUES(?,?,?,?,0)").bind(entry, key, guest.id, 1),
    db
      .prepare(`INSERT INTO tournament_matches(id,tournament_key,room_id,instance_id,phase,updated_at_ms)
      VALUES(?,?,?,?,'saved',1)`)
      .bind(matchId, key, roomId, instanceId),
    db
      .prepare("INSERT INTO tournament_match_players VALUES(?,?,?,?,?)")
      .bind(matchId, entry, guest.id, playerId, matchId),
    db
      .prepare("INSERT INTO account_badge_awards VALUES(?,'four-reversi','games',1,5,0,?)")
      .bind(guest.id, matchId),
    db
      .prepare(
        "INSERT INTO account_badge_notifications VALUES(?,?,'four-reversi',1,NULL,NULL,NULL)",
      )
      .bind(guest.id, matchId),
  ]);
  return { messageId: message, requestId };
}
