import {
  getRoomContract,
  joinRoomContract,
  roomSocketContract,
  type Room,
  type RoomMembership,
} from "@tetraboard/protocol";
import {
  canStoreRoomMembership,
  fetchRoomMembership,
  saveRoomMembershipToken,
} from "./roomMembership";

export const roomChangedMessage =
  "このルームは閉鎖されています。新しい招待リンクを確認するか、ロビーへ戻ってください。";

export function assertRoomIdentity(
  room: Pick<Room, "id" | "instanceId">,
  id: string,
  instanceId?: string,
): void {
  if (room.id !== id) throw new Response("ルーム情報の応答が不正です。", { status: 502 });
  if (instanceId !== undefined && room.instanceId !== instanceId) {
    throw new Response(roomChangedMessage, { status: 410 });
  }
}

export function invitationInstance(url: URL): string | undefined {
  if (!url.searchParams.has("invite")) return undefined;
  const values = url.searchParams.getAll("invite");
  const parsed = roomSocketContract.query.safeParse({ instanceId: values[0] });
  if (values.length !== 1 || !parsed.success) {
    throw new Response("招待リンクが不正です。送信者に確認してください。", { status: 400 });
  }
  return parsed.data.instanceId;
}

export function roomInvitationPath(room: Pick<Room, "id" | "instanceId">): string {
  return `${getRoomContract.pathFor(room.id)}?invite=${room.instanceId}`;
}

export async function fetchRoom(id: string, signal?: AbortSignal, instanceId?: string) {
  const response = await fetch(`/api${getRoomContract.pathFor(id)}?formationAnalysis=1`, {
    method: getRoomContract.method,
    cache: "no-store",
    signal,
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    if (!getRoomContract.error.safeParse(body).success) {
      throw new Response("ルーム情報の応答が不正です。", { status: 502 });
    }
    throw new Response(null, { status: response.status });
  }
  const snapshot = getRoomContract.response.safeParse(body);
  if (!snapshot.success) throw new Response("ルーム情報の応答が不正です。", { status: 502 });
  assertRoomIdentity(snapshot.data.room, id, instanceId);
  return snapshot.data;
}

export class RoomEntryError extends Error {}

export function roomEntryErrorMessage(error: unknown): string {
  if (error instanceof RoomEntryError) return error.message;
  if (error instanceof Response) {
    if (error.status === 410) return roomChangedMessage;
    if (error.status === 404) return "ルームが見つかりません。閉鎖された可能性があります。";
    if (error.status === 503)
      return "本人確認ができませんでした。通信を確認して、もう一度お試しください。";
  }
  return "ルームに参加できませんでした。通信を確認して、もう一度お試しください。";
}

export async function joinRoom(
  id: string,
  name: string | undefined,
  instanceId?: string,
): Promise<{ joined: false } | { joined: true; room: Room; membership: RoomMembership }> {
  if (!canStoreRoomMembership()) {
    throw new RoomEntryError(
      "このタブでは参加情報を保存できません。ブラウザの設定を確認してください。",
    );
  }
  // 資格の再利用より先に、招待先の部屋が同じ世代か確認します。
  if (instanceId !== undefined) await fetchRoom(id, undefined, instanceId);
  const membership = await fetchRoomMembership(id);
  if (membership !== null) return { joined: false };
  const request = joinRoomContract.request.safeParse({ name, instanceId });
  if (!request.success) throw new RoomEntryError("ニックネームを1〜10文字で入力してください。");
  const response = await fetch(`/api${joinRoomContract.pathFor(id)}`, {
    method: joinRoomContract.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request.data),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = joinRoomContract.error.parse(body).error;
    if (error === "room_changed") throw new Response(roomChangedMessage, { status: 410 });
    if (error === "not_found") throw new Response(null, { status: 404 });
    const messages = {
      account_seated:
        "このアカウントは既にルームに参加しています。参加中のタブで遊ぶか、退室してから参加してください。",
      profile_required: "プロフィールの初回設定を完了してください。",
      room_full: "このルームは満室です。観戦するか、空席ができるまでお待ちください。",
      room_started: "このルームの対局は始まっています。対局が終わるまで観戦できます。",
      invalid_request: "入力内容を確認して、もう一度お試しください。",
      rate_limited: "しばらく待ってから、もう一度お試しください。",
    };
    throw new RoomEntryError(
      messages[error as keyof typeof messages] ??
        "ルームに参加できませんでした。もう一度お試しください。",
    );
  }
  const result = joinRoomContract.response.parse(body);
  assertRoomIdentity(result.room, id, instanceId);
  if (
    result.membership.role !== "player" ||
    !result.room.players.some((player) => player.id === result.membership.playerId)
  ) {
    throw new Error("Membership does not match room");
  }
  if (!saveRoomMembershipToken(id, result.membership.token)) {
    throw new RoomEntryError("参加情報を保存できませんでした。ブラウザの設定を確認してください。");
  }
  return { joined: true, room: result.room, membership: result.membership };
}
