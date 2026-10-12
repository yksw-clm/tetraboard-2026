import { gameCapacity } from "@tetraboard/protocol/games";
import { useAccount } from "../account/useAccount";
import { readAccount } from "../account/accountApi";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { type Room, type RoomMembership } from "@tetraboard/protocol";
import {
  joinRoom,
  roomEntryErrorMessage,
  RoomEntryError,
  roomInvitationPath,
} from "../../shared/roomAccess";
import { useRegistrationRestore } from "../account/useRegistrationRestore";
import { roomSounds } from "../../shared/soundEffects";
import { readGuestName } from "../../shared/guestName";
import { canOpenCreatedRoomShare, consumeRoomShareIntent } from "./roomShareIntent";
import { recruitmentUnavailable } from "@tetraboard/protocol/room-sharing";

export function joinUnavailableReason(room: Room): string | null {
  if (room.status === "playing") return "対局中のため、今は観戦のみできます。";
  if (room.players.length >= gameCapacity(room.settings.game))
    return "満室のため、今は観戦のみできます。";
  return null;
}

export function useRoomInvitation(
  room: Room,
  membership: RoomMembership | null,
  invited: boolean,
  restoreJoinFocus: () => void,
  restoreShareFocus: () => void = restoreJoinFocus,
) {
  const navigate = useNavigate();
  const location = useLocation();
  const account = useAccount();
  const restored = useRegistrationRestore();
  const storageKey = `tetraboard:room:${room.id}:${room.instanceId}:invitation-shown`;
  const [autoJoin] = useState(() => {
    if (!invited || membership !== null || joinUnavailableReason(room) !== null) return false;
    try {
      return sessionStorage.getItem(storageKey) !== "1";
    } catch {
      return true;
    }
  });
  const [autoShare] = useState(() => canOpenCreatedRoomShare(location.state, room, membership));
  const [dialog, setDialog] = useState<"join" | "share" | null>(
    autoJoin || restored?.joinName !== undefined ? "join" : autoShare ? "share" : null,
  );
  useEffect(() => {
    if (autoShare) consumeRoomShareIntent(location.state);
  }, [autoShare, location.state]);
  useEffect(() => {
    if (!autoJoin) return;
    // 初期化中には書き込まず、自動表示が描画された後に同じタブの履歴へ記録します。
    try {
      sessionStorage.setItem(storageKey, "1");
    } catch {
      // 保存領域が利用できない場合も、ダイアログを閉じて観戦できます。
    }
  }, [autoJoin, storageKey]);
  const [name, setName] = useState(() => restored?.joinName ?? readGuestName());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const copyingRef = useRef(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyScope = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const invitationUrl = new URL(roomInvitationPath(room), window.location.origin).href;
  const unavailableReason = membership === null ? joinUnavailableReason(room) : null;

  function close(): void {
    if (submitting.current) return;
    if (dialog === "join") {
      requestAnimationFrame(restoreJoinFocus);
    } else if (dialog === "share") {
      requestAnimationFrame(() => requestAnimationFrame(restoreShareFocus));
    }
    copyScope.current++;
    setDialog(null);
  }

  async function copy(onCopied: () => void): Promise<void> {
    if (copyingRef.current) return;
    copyingRef.current = true;
    const scope = copyScope.current;
    setCopyError(null);
    setCopying(true);
    try {
      await navigator.clipboard.writeText(invitationUrl);
      if (mounted.current) onCopied();
    } catch {
      if (mounted.current && scope === copyScope.current)
        setCopyError("コピーできませんでした。URLを選択してコピーしてください。");
    } finally {
      copyingRef.current = false;
      if (mounted.current) setCopying(false);
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
      const result = await joinRoom(room.id, user ? undefined : name, room.instanceId);
      if (result.joined) roomSounds.playJoin(result.room.instanceId, result.membership.playerId);
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
    copying,
    copyError,
    recruitmentUnavailable: recruitmentUnavailable(room),
    openShare: () => {
      copyScope.current++;
      setCopyError(null);
      setDialog("share");
    },
    submit,
    invitationUrl,
    unavailableReason,
    openJoin: () => {
      setMessage(null);
      setDialog("join");
    },
  };
}
