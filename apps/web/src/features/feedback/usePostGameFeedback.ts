import { useEffect, useRef, useState } from "react";
import type { FeedbackInput, Room, RoomMembership } from "@tetraboard/protocol";

export const postGameFeedbackShownKey = "tetraboard:post-game-feedback-shown";
export type PostGameFeedbackContext = {
  game: Room["settings"]["game"];
  opponent: NonNullable<FeedbackInput["opponent"]>;
  accountRequired: boolean;
};

export function usePostGameFeedback(
  room: Room,
  membership: RoomMembership | null,
  authenticated: boolean,
  accountReady: boolean,
  loggedIn: boolean,
) {
  const participation = useRef<Room | null>(null);
  const [context, setContext] = useState<PostGameFeedbackContext | null>(null);
  useEffect(() => {
    if (room.status === "playing") {
      participation.current =
        membership && authenticated && room.players.some((p) => p.id === membership.playerId)
          ? room
          : null;
    }
  }, [room, membership, authenticated]);

  function open() {
    const played = participation.current;
    if (
      !accountReady ||
      !authenticated ||
      !membership ||
      room.status !== "waiting" ||
      !room.lastRound ||
      !room.lastRound.players.some((p) => p.id === membership.playerId)
    )
      return false;
    // 再表示を防げない環境では、任意の評価案内を繰り返し表示しません。
    try {
      if (localStorage.getItem(postGameFeedbackShownKey)) return false;
      localStorage.setItem(postGameFeedbackShownKey, "1");
      if (localStorage.getItem(postGameFeedbackShownKey) !== "1") return false;
    } catch {
      return false;
    }
    setContext({
      game: room.settings.game,
      opponent: room.lastRound.players.some(
        (p) =>
          (p.appearance?.kind ??
            (played?.instanceId === room.instanceId ? played : room).players.find(
              (current) => current.id === p.id,
            )?.kind) === "cpu",
      )
        ? "cpu"
        : "human",
      accountRequired: loggedIn || Boolean(membership.accountLinked),
    });
    return true;
  }
  return { context, open, close: () => setContext(null) };
}
