import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { Room } from "@tetraboard/protocol";
import { useSocialSignIn, type SocialProvider } from "./useSocialSignIn";
import {
  cancelGuestRegistration,
  clearGuestRegistration,
  createGuestRegistration,
  prepareGuestRegistration,
  registrationRoomPath,
} from "./guestRegistration";

export function useResultRegistration(room: Room) {
  const signIn = useSocialSignIn();
  const navigate = useNavigate();
  const submitting = useRef(false);
  const [preparing, setPreparing] = useState<SocialProvider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function start(provider: SocialProvider, linkGuest?: true) {
    if (submitting.current) return;
    submitting.current = true;
    setPreparing(provider);
    setMessage(null);
    try {
      const flow = createGuestRegistration(room, linkGuest);
      if (flow.returning) {
        await navigate("/account");
        return;
      }
      const status = await prepareGuestRegistration(flow);
      if (status.identity !== "unverified") {
        await navigate("/login");
        return;
      }
      if (!["held", "expired"].includes(status.seat) || status.record !== "unclaimed")
        throw new Error("登録する席を保持できません。手続きを確認してください。");
      if (linkGuest && status.seat !== "held")
        throw new Error("席の保持期限が過ぎました。ルームの状態を確認してください。");
      if (status.seat === "expired") {
        // 記録だけを引き継ぐことを確認画面で伝えてから認証へ進みます。
        await navigate("/login");
        return;
      }
      const started = await signIn.start(provider, { path: registrationRoomPath(flow) }, flow);
      if (!started) {
        // OAuthを開始できなかった場合は待機を解除し、次回は新しい試行として扱います。
        await cancelGuestRegistration(flow);
        clearGuestRegistration(flow);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登録を開始できませんでした。");
    } finally {
      submitting.current = false;
      setPreparing(null);
    }
  }
  return {
    busy: preparing !== null || signIn.busy,
    pendingProvider: signIn.pendingProvider ?? preparing,
    message: message ?? signIn.message,
    start,
  };
}
