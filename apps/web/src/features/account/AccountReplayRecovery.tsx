import { useEffect, useRef, useState } from "react";
import { Navigate, useRevalidator, useLocation } from "react-router";
import { useAccount } from "./useAccount";
import { AppPageLoading, AppPageState } from "../../shared/ui/AppPageState";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";

export function AccountReplayRecovery({ generation }: { generation: number }) {
  const { recoverUnauthorized, user, loading, error, sessionLost, refresh } = useAccount();
  const location = useLocation();
  const { revalidate, state } = useRevalidator();
  const retried = useRef(false);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let stopped = false;
    if (retried.current) return;
    const recover = async () => {
      const result = await recoverUnauthorized?.(generation);
      if (stopped) return;
      if (result?.status === "authenticated" || result?.status === "stale") {
        retried.current = true;
        setChecking(false);
        void revalidate();
        return;
      }
      if (!stopped) setChecking(false);
    };
    void recover();
    return () => {
      stopped = true;
    };
  }, [generation, recoverUnauthorized, revalidate]);
  if (!user && !loading && !error)
    return <Navigate to="/login" replace state={{ sessionLost: Boolean(sessionLost) }} />;
  if (checking || state === "loading")
    return <AppPageLoading message="ログイン状態を確認しています…" />;
  return (
    <AppPageState>
      <p role="alert">{error ?? "棋譜を取得できませんでした。もう一度お試しください。"}</p>
      <AppButton
        isDisabled={loading}
        isPending={loading}
        onPress={() => {
          void (async () => {
            if (error) await refresh("page-retry");
            retried.current = false;
            await revalidate();
          })();
        }}
      >
        再試行
      </AppButton>
      <AppButtonLink to="/account" state={location.state}>
        マイページへ戻る
      </AppButtonLink>
    </AppPageState>
  );
}
