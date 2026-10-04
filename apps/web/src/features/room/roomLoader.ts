import {
  roomCodeSchema,
  isFourReversiRoom,
  isFourShogiRoom,
  assertNever,
  type GameId,
  type RoomFor,
  type RoomMembership,
  type RoomPresence,
} from "@tetraboard/protocol";
import type { LoaderFunctionArgs } from "react-router";
import { fetchRoomMembership } from "../../shared/roomMembership";
import { fetchRoom, invitationInstance } from "../../shared/roomAccess";

export type RoomLoaderDataFor<G extends GameId> = {
  game: G;
  room: RoomFor<G>;
  invited: boolean;
  membership: RoomMembership | null;
  serverNowMs: number;
  presence: RoomPresence;
};

export type RoomLoaderData = { [G in GameId]: RoomLoaderDataFor<G> }[GameId];

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
  const common = { membership, presence, serverNowMs, invited: instanceId !== undefined };
  if (isFourReversiRoom(room)) return { ...common, game: "four-reversi", room };
  if (isFourShogiRoom(room)) return { ...common, game: "four-shogi", room };
  return assertNever(room);
}
