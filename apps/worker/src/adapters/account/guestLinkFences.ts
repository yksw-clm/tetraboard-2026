// 入力行の c を参照します。認証セッションは旧形式の数値と ISO 文字列の両方を扱います。
function expiry(column: string) {
  return `CASE WHEN typeof(${column}) IN ('integer','real') THEN ${column} ELSE unixepoch(${column},'subsec')*1000 END`;
}

export const roomLinkFence = `EXISTS(
  SELECT 1 FROM registration_flows r JOIN guest_oauth_flows f ON f.room_registration_id=r.id
  JOIN session s ON s.id=f.target_session_id AND s.userId=f.target_id
  WHERE r.id=c.registration_id AND r.guest_account_id=c.guest_id AND r.cancelled_at_ms IS NULL
    AND r.account_id=f.target_id AND r.session_id=f.target_session_id
    AND f.state=c.oauth_state AND f.guest_id=c.guest_id AND f.target_id=c.target_id
    AND f.expires_at_ms>c.now AND (${expiry("s.expiresAt")})>c.now)`;

export function matchmakingBusy(guest: string, target: string) {
  return `EXISTS(SELECT 1 FROM matchmaking_wait_reservations WHERE account_id IN(${guest},${target}))`;
}

function idleWithHeldSeat(session: string) {
  return `NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(c.guest_id,c.target_id))
    AND NOT EXISTS(SELECT 1 FROM account_room_seats WHERE account_id=c.target_id)
    AND NOT EXISTS(SELECT 1 FROM account_room_seats seat WHERE seat.account_id=c.guest_id
      AND NOT EXISTS(SELECT 1 FROM guest_room_link_commits link
        JOIN registration_flows r ON r.id=link.registration_id JOIN guest_oauth_flows f ON f.state=link.oauth_state
        WHERE link.guest_id=seat.account_id AND r.guest_account_id=seat.account_id
          AND f.guest_id=c.guest_id AND f.target_id=c.target_id ${session} AND f.expires_at_ms>c.now
          AND r.room_id=seat.room_id AND r.instance_id=seat.instance_id AND r.player_id=seat.player_id
          AND r.cancelled_at_ms IS NULL AND r.hold_until_ms>c.now))
    AND NOT EXISTS(SELECT 1 FROM tournament_wait_reservations WHERE account_id IN(c.guest_id,c.target_id))`;
}

const anonymousGuest = "EXISTS(SELECT 1 FROM user WHERE id=c.guest_id AND isAnonymous=1)";
const noRatedWait = `NOT ${matchmakingBusy("c.guest_id", "c.target_id")}`;

export const mergeFence = `${noRatedWait} AND ${anonymousGuest}
  AND EXISTS(SELECT 1 FROM user WHERE id=c.target_id AND COALESCE(isAnonymous,0)=0)
  AND ${idleWithHeldSeat("")}
  AND NOT EXISTS(SELECT 1 FROM tournament_entries g JOIN tournament_entries a ON a.tournament_key=g.tournament_key
    WHERE g.account_id=c.guest_id AND a.account_id=c.target_id)
  AND NOT EXISTS(SELECT 1 FROM account_match_history g JOIN account_match_history a ON a.match_id=g.match_id
    WHERE g.account_id=c.guest_id AND a.account_id=c.target_id)
  AND EXISTS(SELECT 1 FROM guest_oauth_flows f JOIN guest_sessions g ON g.token_hash=f.guest_token_hash
    JOIN session s ON s.id=f.target_session_id AND s.userId=f.target_id
    WHERE f.guest_id=c.guest_id AND f.target_id=c.target_id AND f.expires_at_ms>c.now
      AND g.account_id=f.guest_id AND g.expires_at_ms>c.now AND (${expiry("s.expiresAt")})>c.now)`;

export const promotionFence = `${noRatedWait} AND ${anonymousGuest}
  AND EXISTS(SELECT 1 FROM user WHERE id=c.target_id AND COALESCE(profileCompleted,0)=0)
  AND EXISTS(SELECT 1 FROM guest_sessions WHERE account_id=c.guest_id AND token_hash=c.token_hash AND expires_at_ms>c.now)
  AND EXISTS(SELECT 1 FROM session WHERE id=c.session_id AND userId=c.target_id AND (${expiry("expiresAt")})>c.now)
  AND ${idleWithHeldSeat("AND f.target_session_id=c.session_id")}`;
