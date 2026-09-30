import {
  chatTextSchema,
  membershipTokenSchema,
  type Room,
  type RoomMembership,
} from "@tetraboard/protocol";
import { useState, type FormEvent } from "react";
import { readRoomMembershipToken } from "../../shared/roomMembership";
import { issueViewerToken, reportMessage } from "./roomApi";

type Options = {
  room: Room;
  membership: RoomMembership | null;
  remoteError: string | null;
  sendChat: (text: string) => boolean;
  clearRemoteError: () => void;
};

export function useRoomChat({
  room,
  membership,
  remoteError,
  sendChat,
  clearRemoteError,
}: Options) {
  const [input, setInput] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [hiddenSenders, setHiddenSenders] = useState<string[]>(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem(`tetraboard:hidden:${room.instanceId}`) ?? "[]",
      ) as string[];
    } catch {
      return [];
    }
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = chatTextSchema.safeParse(input);
    if (!parsed.success) {
      clearRemoteError();
      setLocalError("チャットは1～200文字で、URLは投稿できません。");
      return;
    }
    if (!sendChat(parsed.data)) return;
    setInput("");
    setLocalError(null);
  }

  function toggleSender(senderId: string): void {
    const updated = hiddenSenders.includes(senderId)
      ? hiddenSenders.filter((id) => id !== senderId)
      : [...hiddenSenders, senderId];
    setHiddenSenders(updated);
    try {
      sessionStorage.setItem(`tetraboard:hidden:${room.instanceId}`, JSON.stringify(updated));
    } catch {
      /* 保存できない場合も現在の画面では反映します。 */
    }
  }

  async function handleReport(messageId: string): Promise<void> {
    if (reporting !== null) return;
    setReporting(messageId);
    setLocalError(null);
    clearRemoteError();
    try {
      let token = membership === null ? null : readRoomMembershipToken(room.id);
      if (token === null) {
        const key = `tetraboard:viewer:${room.instanceId}`;
        try {
          token = sessionStorage.getItem(key);
        } catch {
          /* 保存できない場合は新たに発行します。 */
        }
        if (token === null || !membershipTokenSchema.safeParse(token).success) {
          token = await issueViewerToken(room.id);
          try {
            sessionStorage.setItem(key, token);
          } catch {
            /* 現在の通報には発行済みの資格を使います。 */
          }
        }
      }
      await reportMessage(room.id, token, messageId);
      setLocalError("通報を受け付けました。");
    } catch {
      setLocalError("通報できませんでした。時間をおいて再度お試しください。");
    } finally {
      setReporting(null);
    }
  }

  return {
    input,
    setInput,
    error: remoteError ?? localError,
    reporting,
    hiddenSenders,
    handleSubmit,
    toggleSender,
    handleReport,
  };
}
