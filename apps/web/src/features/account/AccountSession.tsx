import { accountPrivacyEvent } from "./accountPrivacy";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import type { AccountProfile } from "@tetraboard/protocol";
import {
  accountRequestGeneration,
  advanceAccountRequestGeneration,
  type AccountRecoveryResult,
} from "./accountRequestScope";
import { AccountContext } from "./useAccount";
import { readAccount } from "./accountApi";
import { RegistrationCompletion } from "./RegistrationCompletion";
import { BadgeNotificationProvider } from "../badges/BadgeNotificationProvider";
function accountIdentity(user: AccountProfile | null) {
  return user?.profileId ?? user?.username ?? null;
}
export function AccountLayout() {
  const [state, setState] = useState<{
    user: AccountProfile | null;
    loading: boolean;
    error: string | null;
    pendingSource: string | null;
    generation: number;
    sessionLost: boolean;
  }>({
    user: null,
    loading: true,
    error: null,
    pendingSource: null,
    generation: accountRequestGeneration(),
    sessionLost: false,
  });
  const userRef = useRef<AccountProfile | null>(null);
  const version = useRef(0);
  const active = useRef<{
    controller: AbortController;
    promise: Promise<AccountRecoveryResult>;
  } | null>(null);
  const recovery = useRef<{ generation: number; promise: Promise<AccountRecoveryResult> } | null>(
    null,
  );
  const location = useLocation();
  const update = useCallback((user: AccountProfile | null) => {
    version.current++;
    active.current?.controller.abort();
    recovery.current = null;
    userRef.current = user;
    setState({
      user,
      loading: false,
      error: null,
      pendingSource: null,
      generation: advanceAccountRequestGeneration(),
      sessionLost: false,
    });
  }, []);
  const verify = useCallback((source?: string) => {
    const current = ++version.current;
    active.current?.controller.abort();
    const controller = new AbortController();
    setState((previous) => ({
      ...previous,
      loading: true,
      pendingSource: source ?? null,
      error: source ? previous.error : null,
    }));
    const promise = (async (): Promise<AccountRecoveryResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const stopped = new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException("Session request canceled", "AbortError"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => controller.abort(), 10000);
        });
        const user = await Promise.race([readAccount(controller.signal), stopped]);
        if (current !== version.current)
          return { status: "stale", generation: accountRequestGeneration() };
        const sessionLost = Boolean(userRef.current && !user);
        userRef.current = user;
        const generation = advanceAccountRequestGeneration();
        setState((previous) => ({
          user,
          loading: false,
          error: null,
          pendingSource: null,
          generation,
          sessionLost: sessionLost || (!user && previous.sessionLost),
        }));
        return { status: user ? "authenticated" : "signed-out", generation };
      } catch {
        if (current !== version.current)
          return { status: "stale", generation: accountRequestGeneration() };
        setState((previous) => ({
          ...previous,
          loading: false,
          pendingSource: null,
          error: "ログイン状態を確認できません。再試行してください。",
        }));
        return { status: "unavailable", generation: accountRequestGeneration() };
      } finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        if (active.current?.controller === controller) active.current = null;
      }
    })();
    active.current = { controller, promise };
    return promise;
  }, []);
  const refresh = useCallback(
    async (source?: string) => {
      recovery.current = null;
      await verify(source);
    },
    [verify],
  );
  const recoverUnauthorized = useCallback(
    async (generation: number): Promise<AccountRecoveryResult> => {
      const existing = recovery.current;
      if (existing?.generation === generation) {
        const result = await existing.promise;
        return result.generation === accountRequestGeneration()
          ? result
          : { status: "stale", generation: accountRequestGeneration() };
      }
      if (generation !== accountRequestGeneration())
        return { status: "stale", generation: accountRequestGeneration() };
      const identity = accountIdentity(userRef.current);
      const promise = (active.current?.promise ?? verify("unauthorized")).then(
        (result): AccountRecoveryResult => {
          if (
            result.generation !== accountRequestGeneration() ||
            (result.status === "authenticated" && identity !== accountIdentity(userRef.current))
          )
            return { status: "stale", generation: accountRequestGeneration() };
          return result;
        },
      );
      const entry = { generation, promise };
      recovery.current = entry;
      const result = await promise;
      if (result.status === "unavailable" && recovery.current === entry) recovery.current = null;
      if (
        result.generation !== accountRequestGeneration() ||
        (result.status === "authenticated" && identity !== accountIdentity(userRef.current))
      )
        return { status: "stale", generation: accountRequestGeneration() };
      return result;
    },
    [verify],
  );
  useEffect(() => {
    // 外部のセッション取得結果を画面へ同期します。
    // eslint-disable-next-line react/set-state-in-effect
    void refresh();
    const onFocus = () => void refresh();
    const onPrivacy = () => {
      if (userRef.current) void refresh("privacy");
    };
    window.addEventListener(accountPrivacyEvent, onPrivacy);
    window.addEventListener("focus", onFocus);
    const requests = version;
    return () => {
      requests.current++;
      active.current?.controller.abort();
      recovery.current = null;
      advanceAccountRequestGeneration();
      window.removeEventListener(accountPrivacyEvent, onPrivacy);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  return (
    <AccountContext.Provider value={{ ...state, refresh, update, recoverUnauthorized }}>
      <BadgeNotificationProvider>
        {state.user &&
        !state.user.profileCompleted &&
        location.pathname !== "/account/setup" &&
        location.pathname !== "/" &&
        !["/privacy", "/terms", "/account/deletion"].includes(location.pathname) &&
        location.pathname !== "/feedback" &&
        !/^\/updates(?:\/[^/]+)?\/?$/.test(location.pathname) &&
        !/^\/matches\/[^/]+\/?$/.test(location.pathname) &&
        !(
          location.pathname === "/login" &&
          new URLSearchParams(location.search).get("destination") === "admin"
        ) ? (
          <Navigate to="/account/setup" replace />
        ) : location.pathname === "/account" || location.pathname === "/account/setup" ? (
          <RegistrationCompletion
            enabled={Boolean(state.user?.profileCompleted && !state.loading && !state.error)}
          >
            <Outlet />
          </RegistrationCompletion>
        ) : (
          <Outlet />
        )}
      </BadgeNotificationProvider>
    </AccountContext.Provider>
  );
}
