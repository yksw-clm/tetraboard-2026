import { useEffect } from "react";
import { useRouteError } from "react-router";
import {
  preloadRecovery,
  preloadRecoveryMessage,
  unexpectedErrorMessage,
} from "../preloadRecovery";
import { AppButton } from "./AppButton";
import { AppPageState } from "./AppPageState";

export function AppErrorPage({ error }: { error: unknown }) {
  const preloadError = preloadRecovery.isPreloadError(error);
  useEffect(() => {
    // 遷移先のURLが確定した後に更新します。
    if (preloadError) preloadRecovery.tryAutoReload();
  }, [preloadError]);

  return (
    <AppPageState>
      <p role="alert">{preloadError ? preloadRecoveryMessage : unexpectedErrorMessage}</p>
      <AppButton onPress={() => preloadRecovery.reload()}>再読み込み</AppButton>
    </AppPageState>
  );
}

export function AppRouteErrorPage() {
  return <AppErrorPage error={useRouteError()} />;
}
