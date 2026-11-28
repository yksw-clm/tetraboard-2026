import { recoverMatchmakingRoom } from "../matchmaking/matchmakingRecovery";
import { readMatchmakingRoom } from "../matchmaking/matchmakingStorage";
import { matchmakingPath } from "../matchmaking/paths";
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
import { preloadBoardImage } from "@tetraboard/shogi-ui/board-image";
import { redirect, type LoaderFunctionArgs } from "react-router";
import { readTournamentRoom } from "../tournaments/tournamentQueueStorage";
import { fetchRoomMembership } from "../../shared/roomMembership";
import { fetchRoom, invitationInstance } from "../../shared/roomAccess";
import { takeRoomEntryHandoff } from "../../shared/roomEntryHandoff";

export type RoomLoaderDataFor<G extends GameId> = {
  game: G;
  room: RoomFor<G>;
  invited: boolean;
  membership: RoomMembership | null;
  serverNowMs: number;
  presence: RoomPresence;
  eliminatedHands?: FourShogiEliminatedHands | null;
  stampsSupported?: boolean;
};

export type RoomLoaderData = { [G in GameId]: RoomLoaderDataFor<G> }[GameId];

async function recoverTournamentRoom(id: string, instanceId: string, signal: AbortSignal) {
  const { recoverTournamentRoom } = await import("../tournaments/tournamentRoomRecovery");
  await recoverTournamentRoom(id, instanceId, signal);
}

export async function roomLoader({ params, request }: LoaderFunctionArgs): Promise<RoomLoaderData> {
  const code = roomCodeSchema.safeParse(params.id);
  if (!code.success) {
    throw new Response("ルームIDが不正です。", { status: 400 });
  }
  const id = code.data;
  const url = new URL(request.url);
  const instanceId = invitationInstance(url);
  const watch = url.searchParams.get("watch") === "1";
  const handoff = takeRoomEntryHandoff(id);
  const matchingRoom = readMatchmakingRoom(id, instanceId);
  const matchingReference = watch ? null : matchingRoom;
  if (matchingReference && instanceId) await recoverMatchmakingRoom(id, instanceId, request.signal);
  const tournamentRoom = readTournamentRoom(id, instanceId);
  const tournamentReference = watch ? null : tournamentRoom;
  if (tournamentReference && instanceId)
    await recoverTournamentRoom(id, instanceId, request.signal);
  const entry =
    handoff &&
    !matchingRoom &&
    !tournamentRoom &&
    (instanceId === undefined || handoff.snapshot.room.instanceId === instanceId) &&
    handoff.snapshot.room.players.some((player) => player.id === handoff.currentMembership.playerId)
      ? handoff
      : undefined;
  if (entry) request.signal.throwIfAborted();
  const { room, presence, serverNowMs, stampsSupported, eliminatedHands } =
    entry?.snapshot ??
    (await fetchRoom(id, request.signal, instanceId).catch((error: unknown) => {
      if (matchingReference && error instanceof Response && [404, 410].includes(error.status))
        throw redirect(matchmakingPath(matchingReference.game ?? "four-reversi"));
      const reference = tournamentReference;
      if (reference && instanceId && error instanceof Response && [404, 410].includes(error.status))
        throw redirect(`/tournaments/${reference.tournamentId}?return=unavailable`);
      throw error;
    }));
  if (isShogiRoom(room) || isFourShogiRoom(room)) preloadBoardImage();
  if (tournamentReference && !instanceId && room.instanceId === tournamentReference.instanceId)
    await recoverTournamentRoom(id, room.instanceId, request.signal);
  if (matchingReference && !instanceId && room.instanceId === matchingReference.instanceId)
    await recoverMatchmakingRoom(id, room.instanceId, request.signal);
  const membership =
    entry?.currentMembership ?? (await fetchRoomMembership(room.id, request.signal));
  if (membership !== null && !room.players.some((player) => player.id === membership.playerId)) {
    throw new Response("本人確認の結果がルーム情報と一致しません。", { status: 503 });
  }
  const common = {
    membership,
    presence,
    serverNowMs: entry ? serverNowMs + (performance.now() - entry.receivedAt) : serverNowMs,
    invited: instanceId !== undefined && !watch,
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
      eliminatedHands,
    };
  return assertNever(room);
}
