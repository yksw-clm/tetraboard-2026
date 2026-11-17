import {
  RegistrationError,
  assertRegistrationOAuth,
  type RegistrationFlow,
  type RegistrationIdentity,
} from "../domain/registration";
import { assertRegistrationStatus, registrationStatus } from "../domain/registrationStatus";
export interface RegistrationStore {
  read(id: string): Promise<RegistrationFlow | null>;
  guestRoomLinkComplete(flow: RegistrationFlow): Promise<boolean>;
  rememberOAuth(
    flow: RegistrationFlow,
    state: string,
    provider: string,
    now: number,
  ): Promise<boolean>;
  pendingOAuth(
    state: string,
    now: number,
  ): Promise<{ registration_id: string; provider: string } | null>;
  completeOAuth(
    state: string,
    pending: { registration_id: string; provider: string },
    identity: RegistrationIdentity,
    now: () => number,
  ): Promise<void>;
  hasConsent(accountId: string, legalVersion: string): Promise<boolean>;
}
export async function registrationWithSecret(
  store: RegistrationStore,
  id: string,
  secretHash: () => Promise<string>,
) {
  const flow = await store.read(id);
  if (!flow || flow.secret_hash !== (await secretHash()))
    throw new RegistrationError("unauthorized", 401, "登録手続きの資格を確認できません。");
  return flow;
}
export async function prepareRegistrationOAuth(
  store: RegistrationStore,
  id: string,
  secretHash: () => Promise<string>,
  now: () => number,
) {
  const flow = await registrationWithSecret(store, id, secretHash);
  return assertRegistrationOAuth(flow, now());
}
export async function rememberRegistrationOAuth(
  store: RegistrationStore,
  flow: RegistrationFlow,
  state: string,
  provider: string,
  now: number,
) {
  const saved = await store.rememberOAuth(flow, state, provider, now);
  if (!saved)
    throw new RegistrationError(
      "conflict",
      409,
      "登録手続きの状態が変わりました。元の結果から確認してください。",
    );
}
export async function requireRegistrationConsent(
  store: RegistrationStore,
  accountId: string,
  legalVersion: string,
) {
  const consent = await store.hasConsent(accountId, legalVersion);
  if (!consent)
    throw new RegistrationError("consent_required", 403, "利用規約と年齢条件を確認してください。");
}

export interface RegistrationObservations {
  identity(): Promise<RegistrationIdentity | null>;
  matchState(): Promise<string | null>;
  roomState(): Promise<{ state: string } | null>;
  now(): number;
}
export async function getRegistrationStatus(
  flow: RegistrationFlow,
  observations: RegistrationObservations,
) {
  assertRegistrationStatus(flow);
  const identity = await observations.identity();
  const matchState = await observations.matchState();
  const state = await observations.roomState();
  return registrationStatus(flow, identity, matchState, state, observations.now);
}
export async function completeRegistrationOAuth(
  store: RegistrationStore,
  state: string,
  ports: {
    now(): number;
    acceptProvider(provider: string): boolean;
    identity(): Promise<RegistrationIdentity | null>;
  },
) {
  const pending = await store.pendingOAuth(state, ports.now());
  if (!pending || !ports.acceptProvider(pending.provider)) return;
  const identity = await ports.identity();
  if (!identity) return;
  await store.completeOAuth(state, pending, identity, ports.now);
}
