import { useAccount } from "../account/useAccount";
import { readAccount } from "../account/accountApi";
import {
  createRoomContract,
  getRoomContract,
  roomCodeSchema,
  type RoomError,
  type RoomMode,
} from "@tetraboard/protocol";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { canStoreRoomMembership, saveRoomMembershipToken } from "../../shared/roomMembership";

import { joinRoom, roomEntryErrorMessage, RoomEntryError } from "../../shared/roomAccess";

export type RoomEntryIntent = "create" | "quick" | "join";

function entryErrorMessage(error: RoomError, intent: RoomEntryIntent): string {
  switch (error.error) {
    case "account_seated":
      return "このアカウントは既にルームに参加しています。参加中のタブで遊ぶか、退室してから参加してください。";
    case "profile_required":
      return "プロフィールの初回設定を完了してください。";
    case "not_found":
      return "ルームが見つかりません。番号を確認するか、一覧を更新してください。";
    case "room_full":
      return "このルームは満室です。ほかのルームへの参加や観戦をお試しください。";
    case "room_started":
      return "このルームの対局は始まっています。観戦するか、ほかのルームを選んでください。";
    case "invalid_request":
      return "入力内容を確認して、もう一度お試しください。";
    case "rate_limited":
      return "しばらく待ってから、もう一度お試しください。";
    default:
      return intent === "join"
        ? "ルームに参加できませんでした。もう一度お試しください。"
        : "ルームを作成できませんでした。もう一度お試しください。";
  }
}

export function useRoomEntry(game: "four-reversi" | "four-shogi" = "four-reversi") {
  const navigate = useNavigate();
  const account = useAccount();
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [mode, setMode] = useState<RoomMode>("singles");
  const [threePlayerAttackProhibited, setThreePlayerAttackProhibited] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState<RoomEntryIntent | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const submitting = useRef(false);

  async function submitRoom(intent: RoomEntryIntent, selectedRoomCode = roomCode): Promise<void> {
    if (submitting.current || account.loading || account.error) return;
    const contract = createRoomContract;

    setMessage(null);

    if (intent === "join" && !roomCodeSchema.safeParse(selectedRoomCode).success) {
      setMessage("部屋番号は5桁の数字で入力してください。");
      return;
    }

    if (!canStoreRoomMembership()) {
      setMessage("このタブでは参加情報を保存できません。ブラウザの設定を確認してください。");
      return;
    }

    submitting.current = true;
    setIsSubmitting(intent);

    try {
      const user = await readAccount();
      const wasAccount = Boolean(account.user);
      account.update(user);
      if (wasAccount && !user)
        throw new RoomEntryError(
          "ログインの有効期限が切れました。ログインするか、ニックネームを入力して参加してください。",
        );
      if (user && !user.profileCompleted) return;
      const entryName = user ? undefined : name;
      if (intent === "join") {
        await joinRoom(selectedRoomCode, entryName);
        await navigate(getRoomContract.pathFor(selectedRoomCode));
        return;
      }

      const request = contract.request.safeParse({
        name: entryName,
        quickPlay: intent === "quick",
        mode,
        ...(game === "four-shogi" ? { game, threePlayerAttackProhibited } : {}),
      });
      if (!request.success) {
        setMessage("ニックネームを1〜10文字で入力してください。");
        return;
      }

      const path = createRoomContract.path;
      const response = await fetch(`/api${path}`, {
        method: contract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.data),
      });
      const body: unknown = await response.json();

      if (response.status === 201) {
        const result = contract.response.parse(body);
        if (
          result.room.settings.game !== game ||
          result.membership.role !== "host" ||
          !result.room.players.some((player) => player.id === result.membership.playerId)
        ) {
          throw new Error("Membership does not match room");
        }
        if (!saveRoomMembershipToken(result.room.id, result.membership.token)) {
          throw new Error("Failed to store membership");
        }
        await navigate(getRoomContract.pathFor(result.room.id));
      } else {
        const error = contract.error.parse(body);
        setMessage(entryErrorMessage(error, intent));
      }
    } catch (error) {
      setMessage(
        error instanceof RoomEntryError
          ? error.message
          : error instanceof Response && error.status === 404
            ? "ルームが見つかりません。"
            : intent === "join"
              ? roomEntryErrorMessage(error)
              : "ルームを作成できませんでした。通信を確認して、もう一度お試しください。",
      );
    } finally {
      submitting.current = false;
      setIsSubmitting(null);
    }
  }

  return {
    name,
    setName,
    roomCode,
    setRoomCode,
    mode,
    setMode,
    threePlayerAttackProhibited,
    setThreePlayerAttackProhibited,
    isSubmitting,
    message,
    clearMessage: () => setMessage(null),
    submitRoom,
  };
}
