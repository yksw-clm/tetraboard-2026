import type { SharedRoomSession } from "./useRoomTransport";

export function isRoomSettingsUpdating(
  session: Pick<
    SharedRoomSession,
    "room" | "membership" | "authenticated" | "connection" | "pendingSettingsCommand"
  >,
): boolean {
  return (
    session.room.status === "waiting" &&
    session.membership?.role === "host" &&
    session.authenticated &&
    session.connection === "接続済み" &&
    session.pendingSettingsCommand !== null
  );
}

// 送信ロックは保ち、短い応答待ちで設定欄全体を明滅させないようにします。
export const updatingSettingsClasses = "[--disabled-opacity:1]";
export const updatingSettingsButtonClasses =
  "disabled:opacity-100! data-[disabled=true]:opacity-100!";
