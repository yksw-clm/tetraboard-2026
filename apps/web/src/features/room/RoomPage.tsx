import { isRouteErrorResponse, Link, useLoaderData, useRouteError } from "react-router";
import { type RoomLoaderData } from "./roomLoader";
import { RoomView } from "./RoomView";
import { useRoomChat } from "./useRoomChat";
import { useRoomSession } from "./useRoomSession";

function RoomDetail({
  initialRoom,
  initialMembership,
  initialServerNowMs,
}: {
  initialRoom: RoomLoaderData["room"];
  initialMembership: RoomLoaderData["membership"];
  initialServerNowMs: number;
}) {
  const session = useRoomSession({ initialRoom, initialMembership, initialServerNowMs });
  const chat = useRoomChat({
    room: session.room,
    membership: session.membership,
    remoteError: session.chatError,
    sendChat: session.sendChat,
    clearRemoteError: session.clearChatError,
  });
  return <RoomView session={session} chat={chat} />;
}

export function RoomPage() {
  const { room, membership, serverNowMs } = useLoaderData<RoomLoaderData>();
  return (
    <RoomDetail
      key={`${room.id}:${membership?.playerId ?? "spectator"}`}
      initialRoom={room}
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
        ? "ルームIDが不正です。"
        : error.status === 503
          ? "本人確認ができませんでした。再読み込みしてください。"
          : "ルーム情報を取得できませんでした。"
    : "ルーム情報を取得できませんでした。";

  return (
    <>
      <p>{message}</p>
      <p>
        <Link to="/">トップへ</Link>
      </p>
    </>
  );
}
