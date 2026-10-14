import {
  isFourShogiRoom,
  isShogiRoom,
  membershipTokenSchema,
  registrationCredentialSchema,
  registrationStatusSchema,
  roomCodeSchema,
  roomSocketContract,
  type RegistrationCredential,
  type RegistrationStatus,
  type Room,
} from "@tetraboard/protocol";
import { gameIds, type GameId } from "@tetraboard/protocol/games";
import { readRoomMembershipToken, saveRoomMembershipToken } from "../../shared/roomMembership";

export const guestRegistrationKey = "tetraboard:guest-registration";
export type GuestRegistration = RegistrationCredential & {
  roomId: string;
  instanceId: string;
  matchId: string;
  game: GameId;
  newToken: string;
  createdAtMs: number;
  holdUntilMs?: number;
  claimUntilMs?: number;
  returning?: { playerId: string; record: RegistrationStatus["record"] };
};

export function registrationMatchId(room: Room): string | null {
  if (room.status !== "waiting" || !room.lastRound) return null;
  return isShogiRoom(room) || isFourShogiRoom(room)
    ? room.lastRound.roundId
    : (room.lastRound.replay?.id ?? null);
}

export function registrationRoomPath(flow: GuestRegistration): string {
  return `/rooms/${flow.roomId}?invite=${flow.instanceId}`;
}

export function readGuestRegistration(): GuestRegistration | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(guestRegistrationKey) ?? "null");
    if (!value || typeof value !== "object") return null;
    const flow = value as GuestRegistration;
    if (
      !registrationCredentialSchema.safeParse(value).success ||
      !roomCodeSchema.safeParse(flow.roomId).success ||
      !roomSocketContract.query.safeParse({ instanceId: flow.instanceId }).success ||
      !registrationCredentialSchema.shape.registrationId.safeParse(flow.matchId).success ||
      !membershipTokenSchema.safeParse(flow.newToken).success ||
      !gameIds.includes(flow.game) ||
      !Number.isFinite(flow.createdAtMs) ||
      (flow.holdUntilMs !== undefined && !Number.isFinite(flow.holdUntilMs)) ||
      (flow.claimUntilMs !== undefined && !Number.isFinite(flow.claimUntilMs)) ||
      (flow.returning !== undefined &&
        (!registrationCredentialSchema.shape.registrationId.safeParse(flow.returning.playerId)
          .success ||
          !registrationStatusSchema.shape.record.safeParse(flow.returning.record).success))
    )
      return null;
    return flow;
  } catch {
    return null;
  }
}

export function saveGuestRegistration(flow: GuestRegistration): void {
  try {
    const text = JSON.stringify(flow);
    sessionStorage.setItem(guestRegistrationKey, text);
    if (sessionStorage.getItem(guestRegistrationKey) !== text) throw new Error();
  } catch {
    throw new Error("登録の引継ぎ情報を保存できません。このままゲストとして続けられます。");
  }
}

export function clearGuestRegistration(flow: GuestRegistration): void {
  try {
    if (readGuestRegistration()?.registrationId === flow.registrationId)
      sessionStorage.removeItem(guestRegistrationKey);
  } catch {
    // 保存領域の障害でも、サーバーの取消・完了状態を優先します。
  }
}

function randomSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function createGuestRegistration(room: Room): GuestRegistration {
  const matchId = registrationMatchId(room);
  if (!matchId) throw new Error("引き継ぐ対局を確認できません。結果を開き直してください。");
  const previous = readGuestRegistration();
  if (previous) {
    if (previous.instanceId === room.instanceId && previous.matchId === matchId) return previous;
    throw new Error("別の対局の登録手続きが残っています。先に登録を完了するか中止してください。");
  }
  if (typeof crypto.randomUUID !== "function" || !crypto.subtle)
    throw new Error("この環境では登録の引継ぎを開始できません。このままゲストとして続けられます。");
  const flow: GuestRegistration = {
    registrationId: crypto.randomUUID(),
    secret: randomSecret(),
    roomId: room.id,
    instanceId: room.instanceId,
    matchId,
    game: room.settings.game,
    newToken: randomSecret(),
    createdAtMs: Date.now(),
  };
  saveGuestRegistration(flow);
  return flow;
}

class RegistrationRequestError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.code = code;
  }
}

async function registrationRequest(
  flow: GuestRegistration,
  path: string,
  init?: RequestInit,
): Promise<RegistrationStatus>;
async function registrationRequest(
  flow: GuestRegistration,
  path: string,
  init: RequestInit,
  allowEmpty: true,
): Promise<RegistrationStatus | null>;
async function registrationRequest(
  flow: GuestRegistration,
  path: string,
  init: RequestInit = {},
  allowEmpty = false,
): Promise<RegistrationStatus | null> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Authorization: `Bearer ${flow.secret}`, ...init.headers },
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  if (allowEmpty && response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new RegistrationRequestError(
      body?.message ?? "登録の引継ぎを確認できません。再試行してください。",
      body?.error,
    );
  const status = registrationStatusSchema.parse(body);
  if (
    status.registrationId !== flow.registrationId ||
    status.roomId !== flow.roomId ||
    status.instanceId !== flow.instanceId ||
    status.matchId !== flow.matchId
  )
    throw new Error("登録の引継ぎ対象を確認できません。");
  return status;
}

export async function prepareGuestRegistration(
  flow: GuestRegistration,
): Promise<RegistrationStatus> {
  const token = readRoomMembershipToken(flow.roomId);
  if (!token) throw new Error("参加資格を確認できません。ルームを開き直してください。");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.newToken));
  const newTokenHash = [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const status = await registrationRequest(flow, `/api/rooms/${flow.roomId}/registration`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      registrationId: flow.registrationId,
      secret: flow.secret,
      instanceId: flow.instanceId,
      matchId: flow.matchId,
      newTokenHash,
    }),
  });
  saveGuestRegistration({
    ...flow,
    holdUntilMs: status.holdUntilMs,
    claimUntilMs: status.claimUntilMs,
  });
  return status;
}

export async function getGuestRegistration(flow: GuestRegistration, signal?: AbortSignal) {
  try {
    return await registrationRequest(flow, `/api/registrations/${flow.registrationId}`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof RegistrationRequestError && error.code === "preparing")
      return prepareGuestRegistration(flow);
    throw error;
  }
}

export function completeGuestRegistration(flow: GuestRegistration) {
  return registrationRequest(flow, `/api/registrations/${flow.registrationId}/complete`, {
    method: "POST",
  });
}

export function cancelGuestRegistration(flow: GuestRegistration, signOut = false) {
  return registrationRequest(
    flow,
    `/api/registrations/${flow.registrationId}/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signOut }),
    },
    true,
  );
}

export function commitRegistrationMembership(
  flow: GuestRegistration,
  status: RegistrationStatus,
): void {
  try {
    saveGuestRegistration({
      ...flow,
      returning: { playerId: status.playerId, record: status.record },
    });
    if (
      !saveRoomMembershipToken(flow.roomId, flow.newToken) ||
      readRoomMembershipToken(flow.roomId) !== flow.newToken
    )
      throw new Error();
  } catch {
    throw new Error("新しい参加資格を保存できません。登録情報を残したまま再試行してください。");
  }
}
