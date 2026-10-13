import { useCallback, useEffect, useRef, useState } from "react";
import type { GameId, MatchSummary } from "@tetraboard/protocol";
import { fetchRecentMatches } from "./recentMatchesApi";

export function useRecentMatches(game: GameId | "all") {
  const [humanOnly, setHumanOnly] = useState(false);
  const [page, setPage] = useState({
    matches: [] as MatchSummary[],
    loading: true,
    loaded: false,
    error: null as string | null,
    revision: 0,
  });
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const changeHumanOnly = useCallback(
    (value: boolean) => {
      if (value === humanOnly) return;
      request.current?.abort();
      setHumanOnly(value);
      setPendingSource(null);
      setPage((current) => ({
        matches: [],
        loading: true,
        loaded: false,
        error: null,
        revision: current.revision,
      }));
    },
    [humanOnly],
  );
  const refresh = useCallback(
    async (source: string | null = null) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setPendingSource(source);
      setPage((current) => ({
        ...current,
        loading: true,
        error: source === "retry" ? current.error : null,
      }));
      try {
        const matches = await fetchRecentMatches(game, controller.signal, humanOnly);
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
      } finally {
        if (request.current === controller) {
          request.current = null;
          setPendingSource(null);
        }
      }
    },
    [game, humanOnly],
  );
  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timeout);
      request.current?.abort();
    };
  }, [refresh]);
  return { ...page, pendingSource, humanOnly, changeHumanOnly, refresh };
}
