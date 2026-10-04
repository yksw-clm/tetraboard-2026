import { useRoomChat } from "./useRoomChat";
import type { useRoomTransport } from "./useRoomTransport";
export function useSessionChat(
  session: Pick<
    ReturnType<typeof useRoomTransport>,
    | "room"
    | "membership"
    | "chatError"
    | "sendChat"
    | "clearChatError"
    | "chatNotifications"
    | "chatMessages"
    | "authenticated"
    | "connection"
  >,
) {
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
