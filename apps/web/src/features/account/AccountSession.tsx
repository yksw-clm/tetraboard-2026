import { AccountContext, useAccount } from "./useAccount";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Outlet } from "react-router";
import type { AccountProfile } from "@tetraboard/protocol";
import { readAccount } from "./accountApi";
import "../../shared/heroui.css";
import "./account.css";

export function AccountLayout() {
  return (
    <AccountProvider>
      <Outlet />
    </AccountProvider>
  );
}
export function AccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    user: AccountProfile | null;
    loading: boolean;
    error: string | null;
  }>({ user: null, loading: true, error: null });
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const user = await readAccount();
      if (version !== requestVersion.current) return;
      setState({ user, loading: false, error: null });
    } catch {
      if (version !== requestVersion.current) return;
      setState({
        user: null,
        loading: false,
        error: "ログイン状態を確認できません。再読み込みしてください。",
      });
    }
  }, []);
  useEffect(() => {
    // 非同期のセッション取得結果を画面へ同期します。
    // eslint-disable-next-line react/set-state-in-effect
    void refresh();
    const update = () => void refresh();
    window.addEventListener("focus", update);
    const requests = requestVersion;
    return () => {
      requests.current++;
      window.removeEventListener("focus", update);
    };
  }, [refresh]);
  return (
    <AccountContext.Provider value={{ ...state, refresh }}>{children}</AccountContext.Provider>
  );
}
export function AccountLink() {
  const { user, loading, error } = useAccount();
  if (loading) return <span role="status">確認中…</span>;
  if (error) return <Link to="/login">ログイン状態を確認</Link>;
  return (
    <Link
      className="account-link"
      to={user ? (user.profileCompleted ? "/account" : "/account/setup") : "/login"}
    >
      {user ? "アカウント" : "ログイン"}
    </Link>
  );
}
