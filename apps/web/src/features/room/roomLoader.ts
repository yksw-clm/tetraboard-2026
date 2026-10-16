import {
  roomCodeSchema,
  isFourReversiRoom,
  isReversiRoom,
  isGomokuRoom,
  isFourGomokuRoom,
  isShogiRoom,
  isFourShogiRoom,
  assertNever,
  type GameId,
  type RoomFor,
  type RoomMembership,
  type RoomPresence,
  type FourShogiEliminatedHands,
} from "@tetraboard/protocol";
import { redirect, type LoaderFunctionArgs } from "react-router";
import { recoverTournamentRoom } from "../tournaments/tournamentRoomRecovery";
import { readTournamentRoom } from "../tournaments/tournamentQueueStorage";
import { fetchRoomMembership } from "../../shared/roomMembership";
import { fetchRoom, invitationInstance } from "../../shared/roomAccess";

export type RoomLoaderDataFor<G extends GameId> = {
  game: G;
  room: RoomFor<G>;
  invited: boolean;
  membership: RoomMembership | null;
  serverNowMs: number;
  presence: RoomPresence;
  formationAnalysisSupported?: boolean;
  eliminatedHands?: FourShogiEliminatedHands | null;
  stampsSupported?: boolean;
};

export type RoomLoaderData = { [G in GameId]: RoomLoaderDataFor<G> }[GameId];

export async function roomLoader({ params, request }: LoaderFunctionArgs): Promise<RoomLoaderData> {
  const id = params.id;
  if (!roomCodeSchema.safeParse(id).success) {
    throw new Response("ルームIDが不正です。", { status: 400 });
  }
  const url = new URL(request.url);
  const instanceId = invitationInstance(url);
  const tournamentReference =
    url.searchParams.get("watch") === "1" ? null : readTournamentRoom(id!, instanceId);
  if (tournamentReference && instanceId)
    await recoverTournamentRoom(id!, instanceId, request.signal);
  const { room, presence, serverNowMs, formationAnalysis, stampsSupported, eliminatedHands } =
    await fetchRoom(id!, request.signal, instanceId).catch((error: unknown) => {
      const reference = tournamentReference;
      if (reference && instanceId && error instanceof Response && [404, 410].includes(error.status))
        throw redirect(`/tournaments/${reference.tournamentId}?return=unavailable`);
      throw error;
    });
  if (tournamentReference && !instanceId && room.instanceId === tournamentReference.instanceId)
    await recoverTournamentRoom(id!, room.instanceId, request.signal);
  const membership = await fetchRoomMembership(room.id, request.signal);
  if (membership !== null && !room.players.some((player) => player.id === membership.playerId)) {
    throw new Response("本人確認の結果がルーム情報と一致しません。", { status: 503 });
  }
  const common = {
    membership,
    presence,
    serverNowMs,
    invited: instanceId !== undefined && url.searchParams.get("watch") !== "1",
    stampsSupported: stampsSupported === true,
  };
  if (isShogiRoom(room)) return { ...common, game: "shogi", room };
  if (isFourGomokuRoom(room)) return { ...common, game: "four-gomoku", room };
  if (isGomokuRoom(room)) return { ...common, game: "gomoku", room };
  if (isReversiRoom(room)) return { ...common, game: "reversi", room };
  if (isFourReversiRoom(room)) return { ...common, game: "four-reversi", room };
  if (isFourShogiRoom(room))
    return {
      ...common,
      game: "four-shogi",
      room,
      formationAnalysisSupported: formationAnalysis !== undefined,
      eliminatedHands,
    };
  return assertNever(room);
}
