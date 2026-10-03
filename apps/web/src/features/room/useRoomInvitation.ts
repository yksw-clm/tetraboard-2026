import { useAccount } from "../account/useAccount";
import { readAccount } from "../account/accountApi";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type Room, type RoomMembership } from "@tetraboard/protocol";
import {
  joinRoom,
  roomEntryErrorMessage,
  RoomEntryError,
  roomInvitationPath,
} from "../../shared/roomAccess";

export function joinUnavailableReason(room: Room): string | null {
  if (room.status === "playing") return "対局中のため、今は観戦のみできます。";
  if (room.players.length >= 4) return "満室のため、今は観戦のみできます。";
  return null;
}

export function useRoomInvitation(
  room: Room,
  membership: RoomMembership | null,
  invited: boolean,
  restoreJoinFocus: () => void,
) {
  const navigate = useNavigate();
  const account = useAccount();
  const storageKey = `tetraboard:room:${room.id}:${room.instanceId}:invitation-shown`;
  const [autoJoin] = useState(() => {
    if (!invited || membership !== null || joinUnavailableReason(room) !== null) return false;
    try {
      return sessionStorage.getItem(storageKey) !== "1";
    } catch {
      return true;
    }
  });
  const [dialog, setDialog] = useState<"join" | "copy" | null>(autoJoin ? "join" : null);
  useEffect(() => {
    if (!autoJoin) return;
    // 初期化中には書き込まず、自動表示が描画された後に同じタブの履歴へ記録します。
    try {
      sessionStorage.setItem(storageKey, "1");
    } catch {
      // 保存領域が利用できない場合も、ダイアログを閉じて観戦できます。
    }
  }, [autoJoin, storageKey]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const copying = useRef(false);
  const invitationUrl = new URL(roomInvitationPath(room), window.location.origin).href;
  const unavailableReason = membership === null ? joinUnavailableReason(room) : null;

  function close(): void {
    if (submitting.current) return;
    if (dialog === "join") {
      requestAnimationFrame(restoreJoinFocus);
    }
    setDialog(null);
  }

  async function copy(onCopied: () => void): Promise<void> {
    if (copying.current) return;
    copying.current = true;
    try {
      await navigator.clipboard.writeText(invitationUrl);
      onCopied();
    } catch {
      setDialog("copy");
    } finally {
      copying.current = false;
    }
  }

  async function submit(): Promise<void> {
    if (submitting.current || account.loading || account.error) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const user = await readAccount();
      const wasAccount = Boolean(account.user);
      account.update(user);
      if (wasAccount && !user)
        throw new RoomEntryError(
          "ログインの有効期限が切れました。ログインするか、ニックネームを入力して参加してください。",
        );
      if (user && !user.profileCompleted) return;
      await joinRoom(room.id, user ? undefined : name, room.instanceId);
      // 同じURLでもloaderを再実行し、観戦用の接続を本人の接続へ切り替えます。
      await navigate(roomInvitationPath(room), { replace: true });
    } catch (error) {
      setMessage(roomEntryErrorMessage(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return {
    dialog,
    name,
    setName,
    message,
    busy,
    close,
    copy,
    submit,
    invitationUrl,
    unavailableReason,
    openJoin: () => {
      setMessage(null);
      setDialog("join");
    },
  };
}
