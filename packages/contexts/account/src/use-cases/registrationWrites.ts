import { RegistrationError, type RegistrationFlow } from "../domain/registration";
export type RegistrationStart = {
  registrationId: string;
  secretHash: string;
  roomId: string;
  instanceId: string;
  matchId: string;
  oldTokenHash: string;
  newTokenHash: string;
  guestAccountId: string | null;
  now: number;
};
export type RegistrationStarted = {
  playerId: string;
  startedAtMs: number;
  holdUntilMs: number;
  claimUntilMs: number;
};
export interface RegistrationWriter {
  create(command: RegistrationStart): Promise<void>;
  read(id: string): Promise<RegistrationFlow | null>;
  removeUnprepared(id: string, secretHash: string): Promise<void>;
  started(id: string, state: RegistrationStarted): Promise<void>;
  acceptRecord(id: string, now: number): Promise<void>;
  seat(id: string, state: RegistrationFlow["seat_state"]): Promise<void>;
  completeSeat(id: string): Promise<void>;
  conflictSeat(id: string): Promise<void>;
  cancelGuest(id: string, now: number): Promise<boolean>;
  cancel(
    id: string,
    signOut: boolean,
    now: number,
  ): Promise<{ account_id: string | null; session_id: string | null } | undefined>;
}
export async function startRegistration(store: RegistrationWriter, command: RegistrationStart) {
  const { secretHash, roomId, instanceId, matchId, oldTokenHash, newTokenHash, guestAccountId } =
    command;
  if (oldTokenHash === newTokenHash)
    throw new RegistrationError("invalid_request", 400, "新しい参加資格を用意してください。");
  await store.create(command);
  const flow = (await store.read(command.registrationId))!;
  if (
    flow.secret_hash !== secretHash ||
    flow.room_id !== roomId ||
    flow.instance_id !== instanceId ||
    flow.match_id !== matchId ||
    flow.old_token_hash !== oldTokenHash ||
    flow.new_token_hash !== newTokenHash ||
    flow.guest_account_id !== guestAccountId
  )
    throw new RegistrationError("conflict", 409, "登録手続きの内容が一致しません。");
  if (flow.cancelled_at_ms !== null)
    throw new RegistrationError("cancelled", 409, "この登録手続きは中止されています。");
  return flow;
}
export async function recordRegistrationStart(
  store: RegistrationWriter,
  id: string,
  state: RegistrationStarted,
) {
  await store.started(id, state);
  return (await store.read(id))!;
}
export async function cancelGuestRegistration(store: RegistrationWriter, id: string, now: number) {
  if (!(await store.cancelGuest(id, now)))
    throw new RegistrationError(
      "already_complete",
      409,
      "認証が完了しています。連携の状態を確認してください。",
    );
}
