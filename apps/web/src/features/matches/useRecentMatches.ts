import { useCallback, useEffect, useRef, useState } from "react";
import type { GameId, MatchSummary } from "@tetraboard/protocol";
import { fetchRecentMatches } from "./recentMatchesApi";

export function useRecentMatches(game: GameId) {
  const [page, setPage] = useState({
    matches: [] as MatchSummary[],
    loading: true,
    loaded: false,
    error: null as string | null,
    revision: 0,
  });
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPage((current) => ({ ...current, loading: true, error: null }));
    try {
      const matches = await fetchRecentMatches(game, controller.signal);
      if (controller.signal.aborted) return;
      setPage((current) => ({
        matches,
        loading: false,
        loaded: true,
        error: null,
        revision: current.revision + 1,
      }));
    } catch {
      if (!controller.signal.aborted)
        setPage((current) => ({
          ...current,
          loading: false,
          loaded: true,
          error: "最近の対局を取得できませんでした。",
        }));
    }
  }, [game]);
  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timeout);
      request.current?.abort();
    };
  }, [refresh]);
  return { ...page, refresh };
}
