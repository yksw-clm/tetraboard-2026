import {
  createRoomContract,
  getRoomContract,
  joinRoomContract,
  roomCodeSchema,
  type RoomError,
  type RoomMode,
} from "@tetraboard/protocol";
import { useState } from "react";
import { useNavigate } from "react-router";
import {
  canStoreRoomMembership,
  fetchRoomMembership,
  saveRoomMembershipToken,
} from "../../shared/roomMembership";

export type RoomEntryIntent = "create" | "quick" | "join";

export function useRoomEntry() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [mode, setMode] = useState<RoomMode>("singles");
  const [isSubmitting, setIsSubmitting] = useState<RoomEntryIntent | null>(null);
  const [roomResponse, setRoomResponse] = useState<RoomError | null>(null);
  const [responseStatus, setResponseStatus] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submitRoom(intent: RoomEntryIntent, selectedRoomCode = roomCode): Promise<void> {
    if (isSubmitting !== null) return;
    const contract = intent === "join" ? joinRoomContract : createRoomContract;

    setRoomResponse(null);
    setResponseStatus(null);
    setMessage(null);

    if (intent === "join" && !roomCodeSchema.safeParse(selectedRoomCode).success) {
      setMessage("部屋番号は5桁の数字で入力してください。");
      return;
    }

    if (!canStoreRoomMembership()) {
      setMessage("このタブでは参加情報を保存できません。ブラウザの設定を確認してください。");
      return;
    }

    setIsSubmitting(intent);

    try {
      if (intent === "join") {
        const existingMembership = await fetchRoomMembership(selectedRoomCode);
        if (existingMembership !== null) {
          void navigate(getRoomContract.pathFor(selectedRoomCode));
          return;
        }
      }

      const request = contract.request.safeParse(
        intent === "join" ? { name } : { name, quickPlay: intent === "quick", mode },
      );
      if (!request.success) {
        setMessage("ニックネームを1〜10文字で入力してください。");
        return;
      }

      const path =
        intent === "join" ? joinRoomContract.pathFor(selectedRoomCode) : createRoomContract.path;
      const response = await fetch(`/api${path}`, {
        method: contract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request.data),
      });
      const body: unknown = await response.json();

      if (response.status === (intent === "join" ? 200 : 201)) {
        const result = contract.response.parse(body);
        if (intent === "join" && result.room.id !== selectedRoomCode) {
          throw new Error("Room code does not match response");
        }
        if (
          result.membership.role !== (intent === "join" ? "player" : "host") ||
          !result.room.players.some((player) => player.id === result.membership.playerId)
        ) {
          throw new Error("Membership does not match room");
        }
        if (!saveRoomMembershipToken(result.room.id, result.membership.token)) {
          throw new Error("Failed to store membership");
        }
        void navigate(getRoomContract.pathFor(result.room.id));
      } else {
        const error = contract.error.parse(body);
        setRoomResponse(error);
        setResponseStatus(response.status);
        if (intent === "join") {
          setMessage(
            error.error === "not_found"
              ? "ルームが見つかりません。"
              : error.error === "room_full"
                ? "このルームは満室です。"
                : error.error === "room_started"
                  ? "このルームの対局は始まっています。"
                  : "入室できませんでした。",
          );
        }
      }
    } catch (error) {
      setMessage(
        error instanceof Response && error.status === 404
          ? "ルームが見つかりません。"
          : intent === "join"
            ? "入室または本人確認の応答を確認できませんでした。"
            : "ルーム作成の応答を確認できませんでした。",
      );
    } finally {
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
    roomResponse,
    responseStatus,
    message,
    submitRoom,
  };
}
