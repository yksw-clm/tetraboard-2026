import {
  getRoomMembershipContract,
  membershipTokenSchema,
  type RoomMembership,
} from "@tetraboard/protocol";

function storageKey(roomId: string): string {
  return `tetraboard:room:${roomId}:membership`;
}

export function canStoreRoomMembership(): boolean {
  const key = "tetraboard:membership-storage-check";
  try {
    sessionStorage.setItem(key, "1");
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readRoomMembershipToken(roomId: string): string | null {
  try {
    const token = sessionStorage.getItem(storageKey(roomId));
    if (token !== null && !membershipTokenSchema.safeParse(token).success) {
      sessionStorage.removeItem(storageKey(roomId));
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function saveRoomMembershipToken(roomId: string, token: string): boolean {
  if (!membershipTokenSchema.safeParse(token).success) return false;
  try {
    sessionStorage.setItem(storageKey(roomId), token);
    return true;
  } catch {
    return false;
  }
}

function clearRoomMembershipToken(roomId: string): void {
  try {
    sessionStorage.removeItem(storageKey(roomId));
  } catch {
    // 保存領域が利用できない場合も、閲覧には進めます。
  }
}

async function readMembershipBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Response("本人確認の応答が不正です。", { status: 503 });
  }
}

export async function fetchRoomMembership(
  roomId: string,
  signal?: AbortSignal,
): Promise<RoomMembership | null> {
  const token = readRoomMembershipToken(roomId);
  if (token === null) return null;

  let response: Response;
  try {
    response = await fetch(`/api${getRoomMembershipContract.pathFor(roomId)}`, {
      method: getRoomMembershipContract.method,
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Response("本人確認に失敗しました。", { status: 503 });
  }

  if (response.status === 401) {
    const body = getRoomMembershipContract.error.safeParse(await readMembershipBody(response));
    if (!body.success || body.data.error !== "unauthorized") {
      throw new Response("本人確認の応答が不正です。", { status: 503 });
    }
    clearRoomMembershipToken(roomId);
    return null;
  }

  if (!response.ok) {
    if (!getRoomMembershipContract.error.safeParse(await readMembershipBody(response)).success) {
      throw new Response("本人確認の応答が不正です。", { status: 503 });
    }
    throw new Response(null, { status: response.status });
  }

  const membership = getRoomMembershipContract.response.safeParse(
    await readMembershipBody(response),
  );
  if (!membership.success) {
    throw new Response("本人確認の応答が不正です。", { status: 503 });
  }
  return membership.data;
}
