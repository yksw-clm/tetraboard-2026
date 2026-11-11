import { useCallback, useEffect, useRef, useState } from "react";
import { lobbyGameRatingsSchema, type LobbyGameRatings } from "@tetraboard/protocol/general-lobby";
import { useAccount } from "../account/useAccount";
import { checkAccountPrivacy } from "../account/accountPrivacy";
import { lobbyRequest } from "./generalLobbyApi";

type RatingsState = {
  scope: string;
  data: LobbyGameRatings | null;
  loading: boolean;
  error: boolean;
};

export function useLobbyGameRatings() {
  const account = useAccount();
  const registered = Boolean(account.user && !account.user.isGuest);
  const profileId = account.user?.profileId ?? null;
  const username = account.user?.username ?? null;
  const scope = JSON.stringify([account.generation, registered, profileId, username]);
  const [state, setState] = useState<RatingsState>({
    scope,
    data: null,
    loading: true,
    error: false,
  });
  const request = useRef<AbortController | null>(null);
  const ready = !account.loading && !account.error;
  const load = useCallback(async () => {
    if (!ready || document.visibilityState === "hidden" || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setState((previous) => ({
      scope,
      data: previous.scope === scope ? previous.data : null,
      loading: true,
      error: false,
    }));
    try {
      const data = await lobbyRequest(
        "/lobby/game-ratings",
        lobbyGameRatingsSchema,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        (registered &&
          (!data.viewer ||
            data.viewer.profileId !== profileId ||
            data.viewer.username !== username)) ||
        (!registered && data.viewer)
      ) {
        checkAccountPrivacy();
        throw new Error("Account changed");
      }
      setState({ scope, data, loading: false, error: false });
    } catch {
      if (!controller.signal.aborted) setState({ scope, data: null, loading: false, error: true });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [ready, scope, registered, profileId, username]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
      else {
        request.current?.abort();
        request.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  const current = state.scope === scope ? state : null;
  const data = ready ? (current?.data ?? null) : null;
  return {
    games: data?.games ?? null,
    registered,
    loading: account.loading || !current || current.loading,
    error: Boolean(account.error) || Boolean(current?.error),
    retry: () => (account.error ? account.refresh("retry") : load()),
  };
}

export type LobbyGameRatingsState = ReturnType<typeof useLobbyGameRatings>;
