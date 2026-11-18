import type {
  GuestMergeFlow,
  GuestMergeWrites,
  GuestPromotionChecks,
  GuestPromotionWrites,
} from "@tetraboard/context-account";

import { prepareFenceAbort } from "../../db/fenceAbort";
import { mergeFence, matchmakingBusy, promotionFence, roomLinkFence } from "./guestLinkFences";
import { prepareRegistrationUpdateAbort, registrationAccountAllowed } from "./registrationFence";

export type GuestLinkWrite = D1PreparedStatement | D1PreparedStatement[];

export class D1GuestLinkWrites
  implements GuestMergeWrites<GuestLinkWrite>, GuestPromotionWrites<GuestLinkWrite>
{
  constructor(private readonly db: D1Database) {}

  commitRoomLink(id: string, flow: GuestMergeFlow, now: number) {
    return [
      this.db
        .prepare(`WITH c(registration_id,guest_id,target_id,oauth_state,now) AS (VALUES(?,?,?,?,?))
          INSERT INTO guest_room_link_commits(registration_id,guest_id,target_id,oauth_state,committed_at_ms)
          SELECT registration_id,guest_id,target_id,oauth_state,now FROM c WHERE ${roomLinkFence}`)
        .bind(id, flow.guest_id, flow.target_id, flow.state, now),
      prepareFenceAbort(this.db, { when: "changes()=0", code: "guest_merge_conflict" }),
    ];
  }

  releaseRoomLink(id: string) {
    return this.db.prepare("DELETE FROM guest_room_link_commits WHERE registration_id=?").bind(id);
  }

  recordMerge(guestId: string, targetId: string, now: number) {
    return [
      this.db
        .prepare(`WITH c(guest_id,target_id,now) AS (VALUES(?,?,?))
          INSERT INTO guest_account_merges(guest_id,account_id,merged_at_ms)
          SELECT guest_id,target_id,now FROM c WHERE ${mergeFence}`)
        .bind(guestId, targetId, now),
      this.rejectGuestLink(guestId, targetId, "guest_merge_conflict"),
    ];
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
    return [
      this.db
        .prepare(`WITH c(guest_id,target_id,token_hash,session_id,now) AS (VALUES(?,?,?,?,?))
          INSERT INTO guest_promotions(guest_id,temporary_id,token_hash,session_id,created_at_ms)
          SELECT guest_id,target_id,token_hash,session_id,now FROM c WHERE ${promotionFence}`)
        .bind(flow.guest_id, flow.target_id, hash, flow.target_session_id, now),
      this.rejectGuestLink(flow.guest_id, flow.target_id, "guest_promotion_conflict"),
    ];
  }

  private rejectGuestLink(
    guestId: string,
    targetId: string,
    code: "guest_merge_conflict" | "guest_promotion_conflict",
  ) {
    return prepareFenceAbort(
      this.db,
      {
        when: `changes()=0 AND ${matchmakingBusy("?", "?")}`,
        values: [guestId, targetId],
        code: "account_busy",
      },
      { when: "changes()=0", code },
    );
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
    const candidate = "id=? AND account_id=? AND session_id=?";
    const values = [id, flow.target_id, flow.target_session_id];
    return [
      this.db
        .prepare(`UPDATE registration_flows SET account_id=? WHERE ${candidate}
          AND ${registrationAccountAllowed("?")}`)
        .bind(flow.guest_id, ...values, flow.guest_id),
      prepareRegistrationUpdateAbort(this.db, flow.guest_id, candidate, values),
    ];
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
