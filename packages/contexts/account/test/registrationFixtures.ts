import type {
  RegistrationFlow,
  RegistrationStore,
  RegistrationWriter,
  RegistrationStart,
  RegistrationStarted,
} from "../src";
export const flow: RegistrationFlow & { player_id: string } = {
  id: "registration",
  secret_hash: "hash",
  room_id: "12345",
  instance_id: "instance",
  match_id: "match",
  player_id: "player",
  guest_account_id: null,
  old_token_hash: "old",
  new_token_hash: "new",
  created_at_ms: 1000,
  hold_until_ms: 601000,
  claim_until_ms: 3601000,
  account_id: null,
  session_id: null,
  cancelled_at_ms: null,
  record_accepted_at_ms: null,
  seat_state: "held",
};
export const start: RegistrationStart = {
  registrationId: "registration",
  secretHash: "hash",
  roomId: "12345",
  instanceId: "instance",
  matchId: "match",
  oldTokenHash: "old",
  newTokenHash: "new",
  guestAccountId: null,
  now: 1000,
};
export class MemoryRegistrations implements RegistrationStore, RegistrationWriter {
  flow: RegistrationFlow | null = { ...flow };
  events: string[] = [];
  consent = false;
  pending: { registration_id: string; provider: string } | null = {
    registration_id: flow.id,
    provider: "google",
  };
  async read(id: string) {
    this.events.push(`read:${id}`);
    return this.flow;
  }
  async guestRoomLinkComplete() {
    return false;
  }
  async rememberOAuth() {
    this.events.push("remember");
    return this.flow?.account_id === null;
  }
  async pendingOAuth() {
    this.events.push("pending");
    return this.pending;
  }
  async completeOAuth() {
    this.events.push("complete");
  }
  async hasConsent() {
    return this.consent;
  }
  async create() {
    this.events.push("create");
  }
  async removeUnprepared() {}
  async started(_id: string, state: RegistrationStarted) {
    this.events.push("started");
    if (this.flow && this.flow.cancelled_at_ms === null)
      this.flow = {
        ...this.flow,
        player_id: state.playerId,
        created_at_ms: state.startedAtMs,
        hold_until_ms: state.holdUntilMs,
        claim_until_ms: state.claimUntilMs,
      };
  }
  async acceptRecord() {}
  async seat() {}
  async completeSeat() {}
  async conflictSeat() {}
  async cancelGuest() {
    return this.flow?.account_id === null;
  }
  async cancel() {
    return undefined;
  }
}
