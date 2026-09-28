import { getRoomContract, roomCodeSchema, type Room } from "@tetraboard/protocol";
import type { LoaderFunctionArgs } from "react-router";

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

export async function roomLoader({ params, request }: LoaderFunctionArgs): Promise<Room> {
  const id = params.id;
  if (!roomCodeSchema.safeParse(id).success) {
    throw new Response("ルームIDが不正です。", { status: 400 });
  }
  return fetchRoom(id!, request.signal);
}
