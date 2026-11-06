import { useLocation, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { AppButton } from "../../shared/ui/AppButton";
import { AppDialog } from "../../shared/ui/AppDialog";
import { useAccount } from "./useAccount";
import { accountRequest } from "./accountApi";
import { useSocialSignIn } from "./useSocialSignIn";
import { SocialSignInButtons } from "./SocialSignInButtons";
import { guestStorageNotice } from "./guestAccount";
import { clearGuestRegistration, readGuestRegistration } from "./guestRegistration";
import { clearRegistrationReturn } from "./registrationReturn";

export function GuestAccountControls() {
  const signIn = useSocialSignIn();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{guestStorageNotice}</p>
      <SocialSignInButtons
        onSignIn={(provider) => void signIn.start(provider)}
        busy={signIn.busy}
        pendingProvider={signIn.pendingProvider}
      />
      {signIn.message && (
        <p role="status" className="text-sm">
          {signIn.message}
        </p>
      )}
    </div>
  );
}
export function GuestMergeConfirmation() {
  const account = useAccount();
  const [pending, setPending] = useState<{
      guestName: string;
      isNewTarget?: boolean;
      roomRegistrationId?: string;
      identity: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const identity = account.user?.profileId ?? account.user?.username;
  const location = useLocation(),
    navigate = useNavigate();
  const requested = new URLSearchParams(location.search).get("guestMerge") === "1";
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState<{ identity: string; message: string } | null>(null);
  useEffect(() => {
    if (!identity || account.user?.isGuest || !requested) return;
    const controller = new AbortController();
    void accountRequest("/api/account/guest-merge", { signal: controller.signal })
      .then((body) => {
        if (!controller.signal.aborted) {
          const value = (
            body as {
              pending: {
                guestName: string;
                isNewTarget?: boolean;
                roomRegistrationId?: string;
              } | null;
            }
          ).pending;
          setPending(value ? { ...value, identity } : null);
          setLoadError(null);
          if (!value && readGuestRegistration()?.linkGuest) {
            // 統合の成功応答を失った場合も、確定済みの手続きを再開します。
            const params = new URLSearchParams(location.search);
            params.delete("guestMerge");
            void navigate(location.pathname + (params.size ? `?${params}` : ""), { replace: true });
          }
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoadError({
            identity,
            message: "ゲスト記録の引き継ぎ状態を確認できません。再試行してください。",
          });
      });
    return () => controller.abort();
  }, [
    identity,
    account.user?.isGuest,
    requested,
    revision,
    location.pathname,
    location.search,
    navigate,
  ]);
  async function respond(merge: boolean) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await accountRequest("/api/account/guest-merge", { method: merge ? "POST" : "DELETE" });
      setPending(null);
      const params = new URLSearchParams(location.search);
      params.delete("guestMerge");
      const path = location.pathname + (params.size ? `?${params}` : "");
      const handoff = readGuestRegistration();
      if (!merge && handoff?.linkGuest && handoff.registrationId === pending?.roomRegistrationId) {
        clearGuestRegistration(handoff);
        clearRegistrationReturn();
        window.location.replace(path);
      } else if (merge) window.location.replace(path);
      else await navigate(path, { replace: true });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "引き継ぎできませんでした。");
    } finally {
      setBusy(false);
    }
  }
  if (!pending && loadError && loadError.identity === identity)
    return (
      <div className="app-theme p-3 text-sm">
        <p role="alert">{loadError.message}</p>
        <AppButton size="compact" onPress={() => setRevision((v) => v + 1)}>
          再試行
        </AppButton>
      </div>
    );
  if (!pending || pending.identity !== identity) return null;
  return (
    <AppDialog title="ゲストの記録を引き継ぐ" busy={busy} onClose={() => void respond(false)}>
      <p className="text-sm">
        {pending.isNewTarget
          ? `ゲスト「${pending.guestName}」の名前と全記録を保って連携を完了します。参加中のルームを退室し、大会の待機を取り消してから進んでください。`
          : `ゲスト「${pending.guestName}」の全ゲームの棋譜・戦績・バッジ・大会成績と公開チャットの投稿・通報を「${account.user?.name}」へ引き継ぎますか？プロフィールはログイン先の設定を使い、公開チャットの投稿停止・送信制限も引き継ぎます。引き継がずにログインすると、元ゲストの記録には戻れなくなります。記録は自動削除されません。`}
      </p>
      {pending.isNewTarget && (
        <p className="mt-2 text-sm">
          連携をやめてログインすると、元ゲストの記録には戻れなくなります。記録は自動削除されません。
        </p>
      )}
      {message && <p role="alert">{message}</p>}
      <div className="mt-4 flex gap-3">
        <AppButton onPress={() => void respond(true)} isPending={busy} isDisabled={busy}>
          {pending.isNewTarget ? "連携を完了" : "引き継ぐ"}
        </AppButton>
        <AppButton appearance="secondary" onPress={() => void respond(false)} isDisabled={busy}>
          {pending.isNewTarget ? "連携をやめてログインする" : "引き継がずにログインする"}
        </AppButton>
      </div>
    </AppDialog>
  );
}
