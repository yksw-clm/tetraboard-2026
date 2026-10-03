import { roomSocketContract, type RoomMode } from "@tetraboard/protocol";

export const registrationReturnKey = "tetraboard:registration-return";
const lifetimeMs = 60 * 60 * 1000;

export type RegistrationEntryDraft = {
  intent: "create" | "quick" | "join";
  name: string;
  roomCode: string;
  mode: RoomMode;
  selectedRoomId?: string;
  humanOnly?: boolean;
  threePlayerAttackProhibited?: boolean;
};
export type RegistrationDestination = {
  path: string;
  entry?: RegistrationEntryDraft;
  joinName?: string;
};
export type RegistrationReturn = RegistrationDestination & {
  createdAt: number;
  oauthStarted: boolean;
};

// OAuthの遷移先はサーバーで固定したまま、復帰先だけをアプリ内に限定する。
export function registrationPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  if (path === "/games/four-reversi" || path === "/games/four-shogi") return path;
  const match = /^\/rooms\/(\d{5})\?invite=([^&?#]+)$/.exec(path);
  if (!match || !roomSocketContract.query.safeParse({ instanceId: match[2] }).success) return null;
  return path;
}

export function parseRegistrationReturn(
  value: unknown,
  now = Date.now(),
): RegistrationReturn | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const path = registrationPath(record.path);
  if (
    !path ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    record.createdAt > now ||
    now - record.createdAt >= lifetimeMs ||
    typeof record.oauthStarted !== "boolean"
  )
    return null;
  const result: RegistrationReturn = {
    path,
    createdAt: record.createdAt,
    oauthStarted: record.oauthStarted,
  };
  if (record.entry !== undefined) {
    if (!path.startsWith("/games/") || !record.entry || typeof record.entry !== "object")
      return null;
    const entry = record.entry as Record<string, unknown>;
    if (
      typeof entry.intent !== "string" ||
      !["create", "quick", "join"].includes(entry.intent) ||
      typeof entry.name !== "string" ||
      entry.name.length > 100 ||
      typeof entry.roomCode !== "string" ||
      entry.roomCode.length > 100 ||
      (entry.mode !== "singles" && entry.mode !== "doubles") ||
      (entry.selectedRoomId !== undefined &&
        (typeof entry.selectedRoomId !== "string" || !/^\d{5}$/.test(entry.selectedRoomId))) ||
      (entry.humanOnly !== undefined && typeof entry.humanOnly !== "boolean") ||
      (entry.threePlayerAttackProhibited !== undefined &&
        typeof entry.threePlayerAttackProhibited !== "boolean")
    )
      return null;
    result.entry = {
      intent: entry.intent as RegistrationEntryDraft["intent"],
      name: entry.name,
      roomCode: entry.roomCode,
      mode: entry.mode,
      ...(entry.selectedRoomId === undefined
        ? {}
        : { selectedRoomId: String(entry.selectedRoomId) }),
      ...(entry.humanOnly === undefined ? {} : { humanOnly: entry.humanOnly as boolean }),
      ...(entry.threePlayerAttackProhibited === undefined
        ? {}
        : { threePlayerAttackProhibited: entry.threePlayerAttackProhibited as boolean }),
    };
  }
  if (record.joinName !== undefined) {
    if (
      !path.startsWith("/rooms/") ||
      typeof record.joinName !== "string" ||
      record.joinName.length > 100
    )
      return null;
    result.joinName = record.joinName;
  }
  return result;
}

export function readRegistrationReturn(): RegistrationReturn | null {
  try {
    return parseRegistrationReturn(
      JSON.parse(sessionStorage.getItem(registrationReturnKey) ?? "null"),
    );
  } catch {
    return null;
  }
}
export function clearRegistrationReturn(): void {
  try {
    sessionStorage.removeItem(registrationReturnKey);
  } catch {
    /* 登録自体は続行できる。 */
  }
}
export function saveRegistrationReturn(
  destination: RegistrationDestination,
  oauthStarted: boolean,
): void {
  clearRegistrationReturn();
  const value = parseRegistrationReturn({ ...destination, createdAt: Date.now(), oauthStarted });
  if (!value) return;
  try {
    sessionStorage.setItem(registrationReturnKey, JSON.stringify(value));
  } catch {
    /* 復帰情報がなければマイページへ進む。 */
  }
}

export function registrationReturnFromState(
  state: unknown,
  path: string,
): RegistrationReturn | null {
  if (!state || typeof state !== "object") return null;
  const value = parseRegistrationReturn(
    (state as { registrationReturn?: unknown }).registrationReturn,
  );
  return value?.path === path ? value : null;
}
