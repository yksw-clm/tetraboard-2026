import type {
  GuestMergeFlow,
  GuestMergeWrites,
  GuestPromotionChecks,
  GuestPromotionWrites,
} from "@tetraboard/context-account";

export class D1GuestLinkWrites
  implements GuestMergeWrites<D1PreparedStatement>, GuestPromotionWrites<D1PreparedStatement>
{
  constructor(private readonly db: D1Database) {}

  commitRoomLink(id: string, flow: GuestMergeFlow, now: number) {
    return this.db
      .prepare(`INSERT INTO guest_room_link_commits
      (registration_id,guest_id,target_id,oauth_state,committed_at_ms) VALUES(?,?,?,?,?)`)
      .bind(id, flow.guest_id, flow.target_id, flow.state, now);
  }

  releaseRoomLink(id: string) {
    return this.db.prepare("DELETE FROM guest_room_link_commits WHERE registration_id=?").bind(id);
  }

  recordMerge(guestId: string, targetId: string, now: number) {
    return this.db
      .prepare("INSERT INTO guest_account_merges(guest_id,account_id,merged_at_ms) VALUES(?,?,?)")
      .bind(guestId, targetId, now);
  }

  retireGuest(guestId: string) {
    const db = this.db;
    return [
      db.prepare("DELETE FROM guest_sessions WHERE account_id=?").bind(guestId),
      db.prepare("DELETE FROM session WHERE userId=?").bind(guestId),
      db.prepare("DELETE FROM guest_oauth_flows WHERE guest_id=?").bind(guestId),
      db
        .prepare(
          "UPDATE user SET name='',username=NULL,profileCompleted=0,guestNameCustomized=0 WHERE id=?",
        )
        .bind(guestId),
    ];
  }

  acceptRoomRecord(id: string, targetId: string, now: number) {
    return this.db
      .prepare("UPDATE registration_flows SET record_accepted_at_ms=? WHERE id=? AND account_id=?")
      .bind(now, id, targetId);
  }

  recordPromotion(flow: GuestMergeFlow, hash: string, now: number) {
    return this.db
      .prepare(
        "INSERT INTO guest_promotions(guest_id,temporary_id,token_hash,session_id,created_at_ms) VALUES(?,?,?,?,?)",
      )
      .bind(flow.guest_id, flow.target_id, hash, flow.target_session_id, now);
  }

  releaseTemporaryEmail(targetId: string) {
    return this.db
      .prepare("UPDATE user SET email=? WHERE id=?")
      .bind(`${targetId}@transferred.invalid`, targetId);
  }

  promoteGuest(
    flow: GuestMergeFlow,
    email: string,
    hash: string,
    clock: Pick<GuestPromotionChecks, "now" | "nowIso">,
  ) {
    return this.db
      .prepare(`UPDATE user SET email=?,emailVerified=(SELECT emailVerified FROM user WHERE id=?),
        isAnonymous=0,profileCompleted=0,guestRegisteredAt=?,updatedAt=? WHERE id=? AND isAnonymous=1
        AND EXISTS(SELECT 1 FROM guest_sessions WHERE token_hash=? AND account_id=? AND expires_at_ms>?)`)
      .bind(
        email,
        flow.target_id,
        clock.now(),
        clock.nowIso(),
        flow.guest_id,
        hash,
        flow.guest_id,
        clock.now(),
      );
  }

  transferProviderAndSessions(guestId: string, targetId: string) {
    return [
      this.db.prepare("UPDATE account SET userId=? WHERE userId=?").bind(guestId, targetId),
      this.db.prepare("UPDATE session SET userId=? WHERE userId=?").bind(guestId, targetId),
    ];
  }

  transferRegistration(id: string, flow: GuestMergeFlow) {
    return this.db
      .prepare(
        "UPDATE registration_flows SET account_id=? WHERE id=? AND account_id=? AND session_id=?",
      )
      .bind(flow.guest_id, id, flow.target_id, flow.target_session_id);
  }

  deleteTemporaryUser(targetId: string) {
    return this.db.prepare("DELETE FROM user WHERE id=?").bind(targetId);
  }

  retirePromotedGuestCredentials(guestId: string) {
    return [
      this.db.prepare("DELETE FROM guest_sessions WHERE account_id=?").bind(guestId),
      this.db.prepare("DELETE FROM guest_oauth_flows WHERE guest_id=?").bind(guestId),
      this.db.prepare("DELETE FROM guest_promotions WHERE guest_id=?").bind(guestId),
    ];
  }
}
