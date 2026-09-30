import { roomCodeSchema, type Room, type RoomMembership } from "@tetraboard/protocol";
import type { LoaderFunctionArgs } from "react-router";
import { fetchRoomMembership } from "../../shared/roomMembership";
import { fetchRoom } from "./roomApi";

export type RoomLoaderData = {
  room: Room;
  membership: RoomMembership | null;
  serverNowMs: number;
};

export async function roomLoader({ params, request }: LoaderFunctionArgs): Promise<RoomLoaderData> {
  const id = params.id;
  if (!roomCodeSchema.safeParse(id).success) {
    throw new Response("ルームIDが不正です。", { status: 400 });
  }
  const { room, serverNowMs } = await fetchRoom(id!, request.signal);
  const membership = await fetchRoomMembership(room.id, request.signal);
  if (membership !== null && !room.players.some((player) => player.id === membership.playerId)) {
    throw new Response("本人確認の結果がルーム情報と一致しません。", { status: 503 });
  }
  return { room, membership, serverNowMs };
}
