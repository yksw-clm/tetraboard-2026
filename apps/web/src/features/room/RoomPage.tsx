import { AppButtonLink } from "../../shared/ui/AppButton";
import { isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { roomChangedMessage } from "../../shared/roomAccess";
import { FeedbackEntry } from "../feedback/FeedbackEntry";
import { fourReversiLobbyPath } from "../../app/paths";
import { type RoomLoaderData } from "./roomLoader";
import { RoomView } from "./RoomView";
import { useRoomChat } from "./useRoomChat";
import { useRoomSession } from "./useRoomSession";
import { isFourShogiRoom, type FourReversiRoom, type FourShogiRoom } from "@tetraboard/protocol";
import { FourShogiRoomView } from "./FourShogiRoomView";
import { useFourShogiRoomSession } from "./useFourShogiRoomSession";
import { type useRoomTransport } from "./useRoomTransport";

function RoomDetail({
  initialRoom,
  initialMembership,
  initialServerNowMs,
  initialPresence,
  invited,
}: {
  initialRoom: FourReversiRoom;
  initialMembership: RoomLoaderData["membership"];
  invited: boolean;
  initialServerNowMs: number;
  initialPresence: RoomLoaderData["presence"];
}) {
  const session = useRoomSession({
    initialRoom,
    initialMembership,
    initialServerNowMs,
    initialPresence,
  });
  const chat = useSessionChat(session);
  return <RoomView session={session} chat={chat} invited={invited} />;
}

function useSessionChat(session: ReturnType<typeof useRoomTransport>) {
  return useRoomChat({
    room: session.room,
    membership: session.membership,
    remoteError: session.chatError,
    sendChat: session.sendChat,
    clearRemoteError: session.clearChatError,
    notifications: session.chatNotifications,
    messages: session.chatMessages,
    connected: session.authenticated && session.connection === "接続済み",
  });
}

function FourShogiRoomDetail({
  invited,
  ...options
}: Parameters<typeof useFourShogiRoomSession>[0] & {
  invited: boolean;
  initialRoom: FourShogiRoom;
}) {
  const session = useFourShogiRoomSession(options);
  const chat = useSessionChat(session);
  return <FourShogiRoomView session={session} chat={chat} invited={invited} />;
}

export function RoomPage() {
  const { room, membership, presence, serverNowMs, invited } = useLoaderData<RoomLoaderData>();
  if (isFourShogiRoom(room))
    return (
      <FourShogiRoomDetail
        key={`${room.instanceId}:${membership?.playerId ?? "spectator"}`}
        invited={invited}
        initialRoom={room}
        initialPresence={presence}
        initialMembership={membership}
        initialServerNowMs={serverNowMs}
      />
    );
  return (
    <RoomDetail
      key={`${room.instanceId}:${membership?.playerId ?? "spectator"}`}
      invited={invited}
      initialRoom={room}
      initialPresence={presence}
      initialMembership={membership}
      initialServerNowMs={serverNowMs}
    />
  );
}

export function RoomErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? error.status === 404
      ? "ルームが見つかりません。"
      : error.status === 400
        ? "ルームURLが不正です。招待リンクや部屋番号を確認してください。"
        : error.status === 410
          ? roomChangedMessage
          : error.status === 503
            ? "本人確認ができませんでした。再読み込みしてください。"
            : "ルーム情報を取得できませんでした。"
    : "ルーム情報を取得できませんでした。";

  return (
    <>
      <p>{message}</p>
      <FeedbackEntry context={{ page: "error", game: "all" }} />
      <p>
        <AppButtonLink size="compact" to={fourReversiLobbyPath}>
          ロビーへ
        </AppButtonLink>
      </p>
    </>
  );
}
