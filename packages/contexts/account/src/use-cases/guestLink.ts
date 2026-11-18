import { GuestLinkError, isNewGuestLinkTarget, type GuestMergeFlow } from "../domain/guestLink";
import type { StoredProfile } from "../domain/profile";
import type { RegistrationFlow, RegistrationIdentity } from "../domain/registration";
import { heldRoomRegistration, requireGuestIdle, type GuestLinkChecks } from "./guestLinkChecks";

export async function prepareGuestLink(
  checks: GuestLinkChecks,
  auth: { hasAccountCookie(): boolean; guestIdentity(): Promise<StoredProfile | null> },
  registration?: RegistrationFlow,
) {
  if (auth.hasAccountCookie()) return null;
  const guest = await auth.guestIdentity();
  if (registration?.guest_account_id) {
    if (
      !guest ||
      guest.id !== registration.guest_account_id ||
      !(await heldRoomRegistration(checks, registration.id, guest.id))
    )
      throw new GuestLinkError("連携する席を確認できません。対局結果を開き直してください。");
  } else if (guest) await requireGuestIdle(checks, guest.id);
  return guest;
}

export type GuestOAuthRecord = {
  state: string;
  guestId: string;
  tokenHash: string | null;
  provider: string;
  startedAt: number;
  expiresAt: number;
  roomRegistrationId: string | null;
};

export async function rememberGuestLink(
  store: { remember(record: GuestOAuthRecord): Promise<void> },
  ports: { now(): number; tokenHash(): Promise<string | null> },
  guestId: string,
  state: string,
  provider: string,
  roomRegistrationId?: string,
) {
  const now = ports.now();
  await store.remember({
    state,
    guestId,
    tokenHash: await ports.tokenHash(),
    provider,
    startedAt: now,
    expiresAt: now + 600000,
    roomRegistrationId: roomRegistrationId ?? null,
  });
}

export type PendingGuestLink = {
  guest_id: string;
  provider: string;
  started_at_ms: number;
  room_registration_id: string | null;
};

export interface GuestLinkClaimStore<Write> {
  pending(state: string, hash: string, now: number): Promise<PendingGuestLink | null>;
  ensurePublicProfileId(id: string, profileId: string): Promise<void>;
  targetCreated(id: string): Promise<{ createdAt: string } | null>;
  claim(flow: GuestMergeFlow, expiresAt: number, now: () => number): Write;
  fixRoomRegistration(registrationId: string, flow: GuestMergeFlow): Write;
}

export async function prepareGuestLinkClaim<Write>(
  store: GuestLinkClaimStore<Write>,
  ports: {
    tokenHash(): Promise<string | null>;
    identity(): Promise<RegistrationIdentity | null>;
    suspendGuestSession(): Promise<void>;
    acceptProvider(provider: string): boolean;
    now(): number;
    id(): string;
  },
  state: string | null,
) {
  const hash = await ports.tokenHash();
  if (!hash) return null;
  const identity = await ports.identity();
  if (!identity) return null;
  const pending = state ? await store.pending(state, hash, ports.now()) : null;
  if (!state || !pending || !ports.acceptProvider(pending.provider)) {
    await ports.suspendGuestSession();
    return null;
  }
  await store.ensurePublicProfileId(identity.user.id, ports.id());
  const created = await store.targetCreated(identity.user.id);
  const flow: GuestMergeFlow = {
    state,
    guest_id: pending.guest_id,
    target_id: identity.user.id,
    target_session_id: identity.sessionId,
    is_new_target: Number(
      isNewGuestLinkTarget(identity.user.profileCompleted, created, pending.started_at_ms),
    ),
    name: "",
    room_registration_id: pending.room_registration_id,
  };
  const claim = store.claim(flow, ports.now() + 3600000, () => ports.now());
  const roomClaim = flow.room_registration_id
    ? store.fixRoomRegistration(flow.room_registration_id, flow)
    : undefined;
  return { flow, claim, roomClaim };
}

export async function completeGuestLink(
  flow: GuestMergeFlow,
  claimed: boolean,
  ports: {
    deleteAccountSession(accountId: string, sessionId: string): Promise<void>;
    suspendGuestSession(): Promise<void>;
    promote(flow: GuestMergeFlow): Promise<void>;
    clearGuestSession(): Promise<void>;
    promotionWillBeRetried(): void;
  },
) {
  if (!claimed && flow.room_registration_id) {
    await ports.deleteAccountSession(flow.target_id, flow.target_session_id);
    return "expired";
  }
  if (!claimed) return;
  // 対応の保存後に確認専用へ切り替え、一時障害で元ゲストだけが先に失効することを防ぎます。
  await ports.suspendGuestSession();
  // 初回登録でのみプロバイダーを元のゲストへ移し、内部IDを維持します。
  if (flow.is_new_target) {
    try {
      await ports.promote(flow);
      await ports.clearGuestSession();
      return;
    } catch {
      // 別タブの参加や一時障害では認証応答を保ち、確認画面から再試行します。
      ports.promotionWillBeRetried();
    }
  }
  return "confirm";
}

export async function readGuestMerge(
  store: {
    mergeFlow(
      hash: string,
      identity: RegistrationIdentity,
      now: () => number,
    ): Promise<GuestMergeFlow | null>;
  },
  ports: {
    identity(): Promise<RegistrationIdentity | null>;
    tokenHash(): Promise<string | null>;
    now(): number;
  },
) {
  const identity = await ports.identity();
  const hash = await ports.tokenHash();
  if (!identity || !hash) return null;
  return store.mergeFlow(hash, identity, () => ports.now());
}

export async function cancelGuestRoomLink(
  ports: {
    cancelRegistration(id: string, now: number): Promise<{ room_id: string } | null>;
    cancelRoomRegistration(roomId: string, id: string): Promise<unknown>;
    now(): number;
  },
  registrationId: string,
) {
  const registration = await ports.cancelRegistration(registrationId, ports.now());
  if (!registration) throw new GuestLinkError("ゲスト記録の引き継ぎは完了しています。");
  await ports.cancelRoomRegistration(registration.room_id, registrationId);
}
