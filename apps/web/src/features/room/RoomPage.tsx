import { AppButtonLink } from "../../shared/ui/AppButton";
import { isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { roomChangedMessage } from "../../shared/roomAccess";
import { fourReversiLobbyPath } from "../../app/paths";
import { type RoomLoaderData } from "./roomLoader";
import { RoomView } from "./RoomView";
import { useRoomChat } from "./useRoomChat";
import { useRoomSession } from "./useRoomSession";

function RoomDetail({
  initialRoom,
  initialMembership,
  initialServerNowMs,
  initialPresence,
  invited,
}: {
  initialRoom: RoomLoaderData["room"];
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
  const chat = useRoomChat({
    room: session.room,
    membership: session.membership,
    remoteError: session.chatError,
    sendChat: session.sendChat,
    clearRemoteError: session.clearChatError,
    notifications: session.chatNotifications,
    messages: session.chatMessages,
    connected: session.authenticated && session.connection === "接続済み",
  });
  return <RoomView session={session} chat={chat} invited={invited} />;
}

export function RoomPage() {
  const { room, membership, presence, serverNowMs, invited } = useLoaderData<RoomLoaderData>();
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
      <p>
        <AppButtonLink size="compact" to={fourReversiLobbyPath}>
          ロビーへ
        </AppButtonLink>
      </p>
    </>
  );
}
