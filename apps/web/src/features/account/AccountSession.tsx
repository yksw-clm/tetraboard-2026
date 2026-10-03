import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import type { AccountProfile } from "@tetraboard/protocol";
import { AccountContext } from "./useAccount";
import { readAccount } from "./accountApi";
export function AccountLayout() {
  const [state, setState] = useState<{
    user: AccountProfile | null;
    loading: boolean;
    error: string | null;
  }>({ user: null, loading: true, error: null });
  const version = useRef(0);
  const location = useLocation();
  const update = useCallback((user: AccountProfile | null) => {
    version.current++;
    setState({ user, loading: false, error: null });
  }, []);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const user = await readAccount();
      if (current === version.current) setState({ user, loading: false, error: null });
    } catch {
      if (current === version.current)
        setState((previous) => ({
          ...previous,
          loading: false,
          error: "ログイン状態を確認できません。再試行してください。",
        }));
    }
  }, []);
  useEffect(() => {
    // 外部のセッション取得結果を画面へ同期します。
    // eslint-disable-next-line react/set-state-in-effect
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const requests = version;
    return () => {
      requests.current++;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return (
    <AccountContext.Provider value={{ ...state, refresh, update }}>
      {state.user && !state.user.profileCompleted && location.pathname !== "/account/setup" ? (
        <Navigate to="/account/setup" replace />
      ) : (
        <Outlet />
      )}
    </AccountContext.Provider>
  );
}
