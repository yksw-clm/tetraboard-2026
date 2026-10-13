import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { RegistrationStatus } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { useAccount } from "./useAccount";
import { readAccount } from "./accountApi";
import { SocialSignInButtons } from "./SocialSignInButtons";
import { useSocialSignIn, type SocialProvider } from "./useSocialSignIn";
import { clearRegistrationReturn } from "./registrationReturn";
import {
  cancelGuestRegistration,
  clearGuestRegistration,
  commitRegistrationMembership,
  completeGuestRegistration,
  getGuestRegistration,
  registrationRoomPath,
  type GuestRegistration,
} from "./guestRegistration";

export function GuestRegistrationCompletion({
  flow,
  children,
}: {
  flow: GuestRegistration;
  children?: ReactNode;
}) {
  const account = useAccount();
  const navigate = useNavigate();
  const signIn = useSocialSignIn();
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState<"checking" | "complete" | "cancel" | null>("checking");
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now);
  const version = useRef(0);
  const completing = useRef(false);
  const finishing = useRef(false);
  const busy = (!account.error && working !== null) || signIn.busy || account.loading;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const current = ++version.current;
    const controller = new AbortController();
    if (account.loading || account.error || finishing.current) return;
    // 認証の再確認後に、サーバーで固定した本人との一致を調べます。
    // eslint-disable-next-line react/set-state-in-effect
    setWorking("checking");
    void getGuestRegistration(flow, controller.signal).then(
      (next) => {
        if (version.current !== current) return;
        completing.current = false;
        setStatus(next);
        setMessage(null);
        setWorking(null);
      },
      (error: unknown) => {
        if (version.current !== current) return;
        setWorking(null);
        setMessage(error instanceof Error ? error.message : "登録を確認できませんでした。");
      },
    );
    const generation = version;
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [flow, account.loading, account.error, account.generation, account.user, retry]);

  useEffect(() => {
    if (
      !status ||
      status.identity !== "ready" ||
      working ||
      completing.current ||
      account.loading ||
      account.error ||
      finishing.current ||
      status.seat === "cancelled" ||
      status.record === "expired" ||
      status.record === "conflict" ||
      status.record === "retired"
    )
      return;
    const current = version.current;
    completing.current = true;
    // 同じ手続きの再送はサーバーで重複を防ぎ、応答喪失後も候補資格を復元します。
    // eslint-disable-next-line react/set-state-in-effect
    setWorking("complete");
    void completeGuestRegistration(flow)
      .then(async (next) => {
        if (version.current !== current) return;
        setStatus(next);
        if (next.identity !== "ready") return;
        if (next.seat === "complete") {
          commitRegistrationMembership(flow, next);
          finishing.current = true;
          await navigate(registrationRoomPath(flow), {
            replace: true,
            state: { registrationResult: { matchId: flow.matchId, record: next.record } },
          });
        } else if (
          ["expired", "unavailable"].includes(next.seat) &&
          ["complete", "pending"].includes(next.record)
        ) {
          setMessage(
            "この対局の引継ぎを受け付けました。席の保持期限が過ぎたため、棋譜から確認できます。",
          );
        }
      })
      .catch((error: unknown) => {
        if (version.current === current)
          setMessage(
            error instanceof Error ? error.message : "登録の引継ぎを完了できませんでした。",
          );
      })
      .finally(() => {
        if (version.current === current) setWorking(null);
      });
  }, [status, working, account.loading, account.error, flow, navigate]);

  async function cancel() {
    if (busy || finishing.current) return;
    finishing.current = true;
    version.current++;
    setWorking("cancel");
    setMessage(null);
    try {
      const signOut = status?.identity === "profile_required";
      await cancelGuestRegistration(flow, signOut);
      const user = await readAccount(AbortSignal.timeout(10000));
      account.update(user);
      clearGuestRegistration(flow);
      clearRegistrationReturn();
      await navigate(registrationRoomPath(flow), {
        replace: true,
        state: { registrationCancelledMatchId: flow.matchId },
      });
    } catch (error) {
      finishing.current = false;
      setWorking(null);
      setMessage(error instanceof Error ? error.message : "登録を中止できませんでした。");
    }
  }

  async function retrySignIn(provider: SocialProvider) {
    if (busy) return;
    const started = await signIn.start(provider, { path: registrationRoomPath(flow) }, flow);
    if (!started) await cancel();
  }

  const remaining = Math.max(
    0,
    Math.ceil(((status?.holdUntilMs ?? flow.holdUntilMs ?? now) - now) / 1000),
  );
  const terminal =
    status?.seat === "cancelled" ||
    status?.record === "expired" ||
    status?.record === "retired" ||
    status?.record === "conflict";
  const setupIdentity = status?.identity === "profile_required";
  const setup = setupIdentity && !terminal && !account.user?.profileCompleted;
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5 px-5 py-6">
      <AppCard className="gap-3">
        <h1 className="text-xl font-bold">この対局をアカウントに引き継ぐ</h1>
        {working && (
          <p role="status">
            {working === "cancel"
              ? "登録を中止しています…"
              : working === "complete"
                ? "対局の記録と席を引き継いでいます…"
                : "登録の状態を確認しています…"}
          </p>
        )}
        {status?.seat === "held" && (
          <p className="text-sm text-muted">
            {remaining > 0
              ? `席をあと${Math.floor(remaining / 60)}分${remaining % 60}秒保持します。登録後は同じ席で再戦できます。`
              : "席の保持期限が過ぎました。対局の記録は登録開始から1時間以内なら引き継げます。"}
          </p>
        )}
        {status?.identity === "mismatch" && (
          <p role="alert">
            登録開始時のログイン状態と異なります。手続きを中止し、元の結果からやり直してください。期限は延長されません。
          </p>
        )}
        {status?.seat === "expired" && !terminal && (
          <p role="status">
            席の保持期限が過ぎたため、同じ席への復帰はできません。この対局の記録は引き継げます。
          </p>
        )}
        {status?.seat === "conflict" && (
          <p role="alert">
            このアカウントは別のルームに参加中です。そちらを退室して再試行してください。今回の対局記録は引継ぎの対象です。
          </p>
        )}
        {terminal && (
          <p role="status">
            {status?.seat === "cancelled"
              ? "この登録手続きは中止されています。"
              : status?.record === "conflict"
                ? "対局の参加条件を確認した結果、このアカウントにはこの対局を引き継げません。"
                : "この対局を引き継ぐ期限が過ぎたか、引継ぎの対象ではなくなりました。"}
          </p>
        )}
        {(message || signIn.message || account.error) && (
          <p role="alert">{message ?? signIn.message ?? account.error}</p>
        )}
        {status?.identity === "unverified" && !terminal && (
          <SocialSignInButtons
            busy={busy}
            pendingProvider={signIn.pendingProvider}
            onSignIn={(provider) => void retrySignIn(provider)}
          />
        )}
        {setup && !children && (
          <AppButtonLink to="/account/setup">プロフィールを作成する</AppButtonLink>
        )}
        {(message ||
          account.error ||
          status?.seat === "conflict" ||
          status?.identity === "mismatch") && (
          <AppButton
            isDisabled={busy}
            onPress={() => {
              if (account.error) {
                void account.refresh();
                return;
              }
              completing.current = false;
              setRetry((value) => value + 1);
            }}
          >
            再試行
          </AppButton>
        )}
        {status &&
          ["pending", "complete"].includes(status.record) &&
          status.seat !== "complete" && (
            <AppButtonLink
              to={status.record === "complete" ? `/account/matches/${flow.matchId}` : "/account"}
              onClick={() => {
                clearGuestRegistration(flow);
                clearRegistrationReturn();
              }}
            >
              {status.record === "complete" ? "棋譜を見る" : "マイページへ"}
            </AppButtonLink>
          )}
        {(!terminal || setupIdentity || status?.seat === "held" || status?.seat === "conflict") &&
          status?.seat !== "complete" && (
            <AppButton appearance="secondary" isDisabled={busy} onPress={() => void cancel()}>
              {setupIdentity ? "登録をやめてゲストに戻る" : "手続きを中止してルームへ戻る"}
            </AppButton>
          )}
        {terminal && setupIdentity && (
          <AppButtonLink
            to="/account/setup"
            reloadDocument
            onClick={() => {
              clearGuestRegistration(flow);
              clearRegistrationReturn();
            }}
          >
            プロフィール作成だけを続ける
          </AppButtonLink>
        )}
        {terminal && !setupIdentity && (
          <AppButtonLink
            to={gameCatalog[flow.game].lobbyPath}
            onClick={() => {
              clearGuestRegistration(flow);
              clearRegistrationReturn();
            }}
          >
            ロビーへ戻る
          </AppButtonLink>
        )}
      </AppCard>
      {setup && (
        <fieldset className="min-w-0 border-0 p-0 m-0" disabled={busy}>
          {children}
        </fieldset>
      )}
    </div>
  );
}
