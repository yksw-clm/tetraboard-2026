import { useAccount } from "../account/useAccount";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type Room, type RoomMembership } from "@tetraboard/protocol";
import { joinRoom, roomEntryErrorMessage, roomInvitationPath } from "../../shared/roomAccess";

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
  const [dialog, setDialog] = useState<"join" | "copy" | null>(() =>
    invited && membership === null && joinUnavailableReason(room) === null ? "join" : null,
  );
  const account = useAccount();
  const [guestName, setName] = useState("");
  const name = account.user?.profileCompleted ? account.user.name : guestName;
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
    if (submitting.current) return;
    if (account.loading || account.error) {
      setMessage("ログイン状態を確認できません。ページを再読み込みしてください。");
      return;
    }
    if (account.user && !account.user.profileCompleted) {
      await navigate("/account/setup");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await joinRoom(room.id, name, room.instanceId);
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
