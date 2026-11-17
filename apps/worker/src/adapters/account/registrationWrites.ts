import type {
  RegistrationWriter,
  RegistrationStart,
  RegistrationStarted,
  RegistrationFlow,
} from "@tetraboard/context-account";
import { D1Registrations } from "./registrations";
export class D1RegistrationWrites extends D1Registrations implements RegistrationWriter {
  constructor(private readonly writeDb: D1Database) {
    super(writeDb);
  }
  async create(command: RegistrationStart) {
    await this.writeDb
      .prepare(`INSERT INTO registration_flows
    (id,secret_hash,room_id,instance_id,match_id,old_token_hash,new_token_hash,created_at_ms,hold_until_ms,claim_until_ms,guest_account_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(
        command.registrationId,
        command.secretHash,
        command.roomId,
        command.instanceId,
        command.matchId,
        command.oldTokenHash,
        command.newTokenHash,
        command.now,
        command.now + 600_000,
        command.now + 3_600_000,
        command.guestAccountId,
      )
      .run();
  }
  async removeUnprepared(id: string, secretHash: string) {
    await this.writeDb
      .prepare(
        "DELETE FROM registration_flows WHERE id=? AND secret_hash=? AND player_id IS NULL AND cancelled_at_ms IS NULL",
      )
      .bind(id, secretHash)
      .run();
  }
  async started(id: string, registered: RegistrationStarted) {
    await this.writeDb
      .prepare(
        `UPDATE registration_flows SET player_id=?,created_at_ms=?,hold_until_ms=?,claim_until_ms=? WHERE id=? AND cancelled_at_ms IS NULL`,
      )
      .bind(
        registered.playerId,
        registered.startedAtMs,
        registered.holdUntilMs,
        registered.claimUntilMs,
        id,
      )
      .run();
  }
  async acceptRecord(id: string, now: number) {
    await this.writeDb
      .prepare(
        "UPDATE registration_flows SET record_accepted_at_ms=COALESCE(record_accepted_at_ms,?) WHERE id=?",
      )
      .bind(now, id)
      .run();
  }
  async completeSeat(id: string) {
    await this.writeDb
      .prepare("UPDATE registration_flows SET seat_state='complete' WHERE id=?")
      .bind(id)
      .run();
  }
  async conflictSeat(id: string) {
    await this.writeDb
      .prepare("UPDATE registration_flows SET seat_state='conflict' WHERE id=?")
      .bind(id)
      .run();
  }
  async seat(id: string, state: RegistrationFlow["seat_state"]) {
    await this.writeDb
      .prepare("UPDATE registration_flows SET seat_state=? WHERE id=?")
      .bind(state, id)
      .run();
  }
  async cancelGuest(id: string, now: number) {
    const cancelled = await this.writeDb
      .prepare(`UPDATE registration_flows
      SET cancelled_at_ms=COALESCE(cancelled_at_ms,?),seat_state='cancelled' WHERE id=?
      AND account_id IS NULL AND NOT EXISTS (SELECT 1 FROM guest_oauth_flows f
        WHERE f.room_registration_id=registration_flows.id AND f.target_id IS NOT NULL)
      RETURNING id`)
      .bind(now, id)
      .first();
    return Boolean(cancelled);
  }
  async cancel(id: string, signOut: boolean, now: number) {
    const cancelled = await this.writeDb.batch<{
      account_id: string | null;
      session_id: string | null;
    }>([
      this.writeDb
        .prepare(
          "UPDATE registration_flows SET cancelled_at_ms=COALESCE(cancelled_at_ms,?),seat_state='cancelled' WHERE id=? RETURNING account_id,session_id",
        )
        .bind(now, id),
      this.writeDb
        .prepare("DELETE FROM registration_oauth_states WHERE registration_id=?")
        .bind(id),
      ...(signOut
        ? [
            this.writeDb
              .prepare(`DELETE FROM session WHERE EXISTS (SELECT 1 FROM registration_flows f
            WHERE f.id=? AND f.session_id=session.id AND f.account_id=session.userId)`)
              .bind(id),
          ]
        : []),
    ]);
    return cancelled[0].results[0];
  }
}
