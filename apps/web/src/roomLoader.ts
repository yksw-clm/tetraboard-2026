import {
  getRoomContract,
  roomCodeSchema,
  type Room,
  type RoomMembership,
} from "@tetraboard/protocol";
import type { LoaderFunctionArgs } from "react-router";
import { fetchRoomMembership } from "./roomMembership";

export type RoomLoaderData = { room: Room; membership: RoomMembership | null };

export async function fetchRoom(id: string, signal: AbortSignal): Promise<Room> {
  const response = await fetch(`/api${getRoomContract.pathFor(id)}`, {
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

  const room = getRoomContract.response.safeParse(body);
  if (!room.success || room.data.id !== id) {
    throw new Response("ルーム情報の応答が不正です。", { status: 502 });
  }
  return room.data;
}

export async function roomLoader({ params, request }: LoaderFunctionArgs): Promise<RoomLoaderData> {
  const id = params.id;
  if (!roomCodeSchema.safeParse(id).success) {
    throw new Response("ルームIDが不正です。", { status: 400 });
  }
  const room = await fetchRoom(id!, request.signal);
  const membership = await fetchRoomMembership(room.id, request.signal);
  if (membership !== null && !room.players.some((player) => player.id === membership.playerId)) {
    throw new Response("本人確認の結果がルーム情報と一致しません。", { status: 503 });
  }
  return { room, membership };
}
