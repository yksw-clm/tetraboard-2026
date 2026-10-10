import {
  chatTextSchema,
  membershipTokenSchema,
  type Room,
  type RoomMembership,
  type ChatEntry,
} from "@tetraboard/protocol";
import { useAppToastQueue } from "../../shared/ui/appToastContext";
import { gameThemes } from "../../shared/ui/appTheme";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { readRoomMembershipToken } from "../../shared/roomMembership";
import { issueViewerToken, reportMessage } from "./roomApi";

type Options = {
  room: Room;
  membership: RoomMembership | null;
  remoteError: string | null;
  sendChat: (text: string) => boolean;
  clearRemoteError: () => void;
  notifications: ChatEntry[];
  messages: ChatEntry[];
  connected: boolean;
};

export function useRoomChat({
  room,
  membership,
  remoteError,
  sendChat,
  clearRemoteError,
  notifications,
  messages,
  connected,
}: Options) {
  const [input, setInput] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const { queue: toastQueue, shared: toastManagedGlobally } = useAppToastQueue();
  const seenNotifications = useRef(new Set<string>());
  const submission = useRef<{ text: string; ids: Set<string> } | null>(null);
  const [pending, setPending] = useState(false);
  const [hiddenSenders, setHiddenSenders] = useState<string[]>(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem(`tetraboard:hidden:${room.instanceId}`) ?? "[]",
      ) as string[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    for (const entry of notifications) {
      if (seenNotifications.current.has(entry.id)) continue;
      seenNotifications.current.add(entry.id);
      if (
        entry.kind === "player" &&
        (entry.senderId === membership?.playerId || hiddenSenders.includes(entry.senderId))
      )
        continue;
      toastQueue.add(
        {
          title: entry.kind === "system" ? "ルームのお知らせ" : entry.senderName,
          description: entry.text,
          theme: gameThemes[room.settings.game],
        },
        { timeout: 3000 },
      );
    }
    seenNotifications.current = new Set(notifications.map((entry) => entry.id));
  }, [notifications, membership?.playerId, hiddenSenders, toastQueue, room.settings.game]);

  useEffect(
    () => () => {
      if (!toastManagedGlobally) toastQueue.clear();
    },
    [toastQueue, toastManagedGlobally],
  );

  useEffect(() => {
    const sent = submission.current;
    if (sent === null) return;
    if (
      messages.some(
        (entry) =>
          entry.kind === "player" &&
          entry.senderId === membership?.playerId &&
          entry.text === sent.text &&
          !sent.ids.has(entry.id),
      )
    ) {
      setInput((value) => (value.trim() === sent.text ? "" : value));
    } else if (!remoteError && connected) return;
    submission.current = null;
    setPending(false);
  }, [messages, membership?.playerId, remoteError, connected]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (submission.current !== null) return;
    const parsed = chatTextSchema.safeParse(input);
    if (!parsed.success) {
      clearRemoteError();
      setLocalError("チャットは1～100文字で、URLは投稿できません。");
      return;
    }
    if (!sendChat(parsed.data)) return;
    submission.current = { text: parsed.data, ids: new Set(messages.map((entry) => entry.id)) };
    setPending(true);
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
    pending,
    toastQueue,
    toastManagedGlobally,
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
