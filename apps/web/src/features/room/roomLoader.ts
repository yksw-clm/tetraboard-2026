import {
  roomCodeSchema,
  type Room,
  type RoomMembership,
  type RoomPresence,
} from "@tetraboard/protocol";
import type { LoaderFunctionArgs } from "react-router";
import { fetchRoomMembership } from "../../shared/roomMembership";
import { fetchRoom, invitationInstance } from "../../shared/roomAccess";

export type RoomLoaderData = {
  room: Room;
  invited: boolean;
  membership: RoomMembership | null;
  serverNowMs: number;
  presence: RoomPresence;
};

export async function roomLoader({ params, request }: LoaderFunctionArgs): Promise<RoomLoaderData> {
  const id = params.id;
  if (!roomCodeSchema.safeParse(id).success) {
    throw new Response("ルームIDが不正です。", { status: 400 });
  }
  const instanceId = invitationInstance(new URL(request.url));
  const { room, presence, serverNowMs } = await fetchRoom(id!, request.signal, instanceId);
  const membership = await fetchRoomMembership(room.id, request.signal);
  if (membership !== null && !room.players.some((player) => player.id === membership.playerId)) {
    throw new Response("本人確認の結果がルーム情報と一致しません。", { status: 503 });
  }
  return { room, membership, presence, serverNowMs, invited: instanceId !== undefined };
}
