import { membershipTokenSchema } from "@tetraboard/protocol";

export type TournamentQueueCredential = {
  operationId: string;
  token: string;
  controllerVersion?: number;
};
const keyFor = (id: number, identity: string) => `tetraboard:tournament:${id}:${identity}:queue`;
export function readTournamentQueue(
  id: number,
  identity: string,
  legacyIdentity?: string,
): TournamentQueueCredential | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(keyFor(id, identity)) ?? "null");
    if (!value && legacyIdentity && legacyIdentity !== identity) {
      const legacy = readTournamentQueue(id, legacyIdentity);
      if (legacy) {
        sessionStorage.setItem(keyFor(id, identity), JSON.stringify(legacy));
        sessionStorage.removeItem(keyFor(id, legacyIdentity));
      }
      return legacy;
    }
    return value &&
      typeof value.operationId === "string" &&
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value.operationId) &&
      membershipTokenSchema.safeParse(value.token).success
      ? {
          operationId: value.operationId,
          token: value.token,
          ...(Number.isSafeInteger(value.controllerVersion) && value.controllerVersion > 0
            ? { controllerVersion: value.controllerVersion }
            : {}),
        }
      : null;
  } catch {
    return null;
  }
}
export function createTournamentQueue(id: number, identity: string): TournamentQueueCredential {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const credential = {
    operationId: crypto.randomUUID(),
    token: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
  saveTournamentQueue(id, identity, credential);
  return credential;
}
export function saveTournamentQueue(
  id: number,
  identity: string,
  credential: TournamentQueueCredential,
) {
  try {
    sessionStorage.setItem(keyFor(id, identity), JSON.stringify(credential));
    if (readTournamentQueue(id, identity)?.token !== credential.token) throw new Error();
  } catch {
    throw new Error("対局の参加資格を保存できません。ブラウザの保存領域を有効にしてください。");
  }
}
export function clearTournamentQueue(id: number, identity: string, legacyIdentity?: string) {
  try {
    sessionStorage.removeItem(keyFor(id, identity));
    if (legacyIdentity && legacyIdentity !== identity)
      sessionStorage.removeItem(keyFor(id, legacyIdentity));
  } catch {
    /* サーバー側の待機期限でも回収します。 */
  }
}

type TournamentRoomReference = {
  tournamentId: number;
  identity: string;
  operationId: string;
  roomId: string;
  instanceId: string;
  controllerVersion?: number;
};
export function saveTournamentRoom(reference: TournamentRoomReference) {
  try {
    sessionStorage.setItem(
      `tetraboard:tournament-room:${reference.roomId}`,
      JSON.stringify(reference),
    );
    return true;
  } catch {
    return false;
  }
}
export function readTournamentRoom(
  roomId: string,
  instanceId?: string,
): TournamentRoomReference | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(`tetraboard:tournament-room:${roomId}`) ?? "null",
    );
    return value &&
      Number.isSafeInteger(value.tournamentId) &&
      value.tournamentId > 0 &&
      typeof value.identity === "string" &&
      typeof value.operationId === "string" &&
      value.roomId === roomId &&
      typeof value.instanceId === "string" &&
      (!instanceId || value.instanceId === instanceId)
      ? value
      : null;
  } catch {
    return null;
  }
}
