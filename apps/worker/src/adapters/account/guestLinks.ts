import type {
  GuestLinkClaimStore,
  GuestMergeFlow,
  GuestOAuthRecord,
  PendingGuestLink,
  RegistrationIdentity,
} from "@tetraboard/context-account";

import { prepareRegistrationUpdateAbort, registrationAccountAllowed } from "./registrationFence";

export class D1GuestLinks implements GuestLinkClaimStore<
  D1PreparedStatement,
  D1PreparedStatement[]
> {
  constructor(private readonly db: D1Database) {}

  async guestBusy(id: string) {
    const busy = await this.db
      .prepare(`SELECT 1 FROM account_room_seats WHERE account_id=?
    UNION ALL SELECT 1 FROM tournament_wait_reservations WHERE account_id=?
 UNION ALL SELECT 1 FROM matchmaking_wait_reservations WHERE account_id=? LIMIT 1`)
      .bind(id, id, id)
      .first();
    return Boolean(busy);
  }

  async roomsForAccount(id: string) {
    const rooms = await this.db
      .prepare("SELECT room_id FROM privacy_room_accounts WHERE account_id=?")
      .bind(id)
      .all<{ room_id: string }>();
    return rooms.results.map((room) => room.room_id);
  }

  targetEmail(id: string) {
    return this.db.prepare("SELECT email FROM user WHERE id=?").bind(id).first<{ email: string }>();
  }

  async remember(record: GuestOAuthRecord) {
    await this.db
      .prepare(
        "INSERT INTO guest_oauth_flows(state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,room_registration_id) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        record.state,
        record.guestId,
        record.tokenHash,
        record.provider,
        record.startedAt,
        record.expiresAt,
        record.roomRegistrationId,
      )
      .run();
  }

  pending(state: string, hash: string, now: number) {
    return this.db
      .prepare(
        "SELECT guest_id,provider,started_at_ms,room_registration_id FROM guest_oauth_flows WHERE state=? AND guest_token_hash=? AND expires_at_ms>? AND target_id IS NULL",
      )
      .bind(state, hash, now)
      .first<PendingGuestLink>();
  }

  async ensurePublicProfileId(id: string, profileId: string) {
    await this.db
      .prepare("UPDATE user SET publicProfileId=COALESCE(publicProfileId,?) WHERE id=?")
      .bind(profileId, id)
      .run();
  }

  targetCreated(id: string) {
    return this.db
      .prepare("SELECT createdAt,email FROM user WHERE id=?")
      .bind(id)
      .first<{ createdAt: string; email: string }>();
  }

  claim(flow: GuestMergeFlow, expiresAt: number, now: () => number) {
    return this.db
      .prepare(
        `UPDATE guest_oauth_flows SET target_id=?,target_session_id=?,is_new_target=?,expires_at_ms=?
     WHERE state=? AND target_id IS NULL AND (room_registration_id IS NULL OR EXISTS(
       SELECT 1 FROM registration_flows r WHERE r.id=room_registration_id AND r.guest_account_id=guest_id
         AND r.cancelled_at_ms IS NULL AND r.claim_until_ms>? AND r.account_id IS NULL
         AND EXISTS (SELECT 1 FROM registration_oauth_states s WHERE s.state=guest_oauth_flows.state AND s.registration_id=r.id AND s.expires_at_ms>?)
     )) RETURNING state`,
      )
      .bind(
        flow.target_id,
        flow.target_session_id,
        flow.is_new_target,
        expiresAt,
        flow.state,
        now(),
        now(),
      );
  }

  fixRoomRegistration(id: string, flow: GuestMergeFlow) {
    const candidate = `id=? AND account_id IS NULL AND cancelled_at_ms IS NULL AND EXISTS (
      SELECT 1 FROM guest_oauth_flows f WHERE f.state=? AND f.room_registration_id=registration_flows.id
        AND f.target_id=? AND f.target_session_id=?
    )`;
    const values = [id, flow.state, flow.target_id, flow.target_session_id];
    return [
      this.db
        .prepare(`UPDATE registration_flows SET account_id=?,session_id=? WHERE ${candidate}
          AND ${registrationAccountAllowed("?")}`)
        .bind(flow.target_id, flow.target_session_id, ...values, flow.target_id),
      prepareRegistrationUpdateAbort(this.db, flow.target_id, candidate, values),
    ];
  }

  async commitClaim(claim: D1PreparedStatement, roomClaim?: D1PreparedStatement[]) {
    if (!roomClaim) return claim.first();
    const [result] = await this.db.batch([claim, ...roomClaim]);
    return result.results[0];
  }

  async deleteAccountSession(accountId: string, sessionId: string) {
    await this.db
      .prepare("DELETE FROM session WHERE id=? AND userId=?")
      .bind(sessionId, accountId)
      .run();
  }

  mergeFlow(hash: string, identity: RegistrationIdentity, now: () => number) {
    return this.db
      .prepare(`SELECT f.*,u.name FROM guest_oauth_flows f JOIN user u ON u.id=f.guest_id
    JOIN guest_sessions s ON s.token_hash=f.guest_token_hash AND s.account_id=f.guest_id
    WHERE f.guest_token_hash=? AND f.target_id=? AND f.target_session_id=? AND f.expires_at_ms>? AND s.expires_at_ms>?
    AND u.isAnonymous=1 AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=f.guest_id)
    ORDER BY f.started_at_ms DESC LIMIT 1`)
      .bind(hash, identity.user.id, identity.sessionId, now(), now())
      .first<GuestMergeFlow>();
  }

  cancelRegistration(id: string, now: number) {
    return this.db
      .prepare(`UPDATE registration_flows
      SET cancelled_at_ms=COALESCE(cancelled_at_ms,?),seat_state='cancelled'
      WHERE id=? AND NOT EXISTS (SELECT 1 FROM guest_account_merges WHERE guest_id=registration_flows.guest_account_id)
        AND EXISTS (SELECT 1 FROM user WHERE id=registration_flows.guest_account_id AND isAnonymous=1)
      RETURNING room_id`)
      .bind(now, id)
      .first<{ room_id: string }>();
  }
}
