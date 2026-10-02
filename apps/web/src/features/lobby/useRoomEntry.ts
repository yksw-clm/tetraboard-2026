import { useAccount } from "../account/useAccount";
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

import { joinRoom, roomEntryErrorMessage } from "../../shared/roomAccess";

export type RoomEntryIntent = "create" | "quick" | "join";

function entryErrorMessage(error: RoomError, intent: RoomEntryIntent): string {
  switch (error.error) {
    case "not_found":
      return "ルームが見つかりません。番号を確認するか、一覧を更新してください。";
    case "room_full":
      return "このルームは満室です。ほかのルームへの参加や観戦をお試しください。";
    case "room_started":
      return "このルームの対局は始まっています。観戦するか、ほかのルームを選んでください。";
    case "profile_incomplete":
      return "アカウント設定を完了してください。";
    case "already_joined":
      return "このアカウントは参加済みです。元のタブから操作してください。";
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

export function useRoomEntry() {
  const navigate = useNavigate();
  const account = useAccount();
  const [guestName, setName] = useState("");
  const name = account.user?.profileCompleted ? account.user.name : guestName;
  const [roomCode, setRoomCode] = useState("");
  const [mode, setMode] = useState<RoomMode>("singles");
  const [isSubmitting, setIsSubmitting] = useState<RoomEntryIntent | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const submitting = useRef(false);

  async function submitRoom(intent: RoomEntryIntent, selectedRoomCode = roomCode): Promise<void> {
    if (submitting.current) return;
    if (account.loading || account.error) {
      setMessage("ログイン状態を確認できません。ページを再読み込みしてください。");
      return;
    }
    if (account.user && !account.user.profileCompleted) {
      await navigate("/account/setup");
      return;
    }
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
      if (intent === "join") {
        await joinRoom(selectedRoomCode, name);
        await navigate(getRoomContract.pathFor(selectedRoomCode));
        return;
      }

      const request = contract.request.safeParse({ name, quickPlay: intent === "quick", mode });
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
        error instanceof Response && error.status === 404
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
    isSubmitting,
    message,
    clearMessage: () => setMessage(null),
    submitRoom,
  };
}
